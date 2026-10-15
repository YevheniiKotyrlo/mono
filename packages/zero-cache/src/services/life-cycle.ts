import {EventEmitter as NodeEventEmitter} from 'node:events';
import type {IncomingHttpHeaders} from 'node:http';
import {pid} from 'node:process';
import type {EventEmitter} from 'stream';
import type {LogContext} from '@rocicorp/logger';
import {AbortError} from '../../../shared/src/abort-error.ts';
import {must} from '../../../shared/src/must.ts';
import {resolver} from '../../../shared/src/resolver.ts';
import {sleep} from '../../../shared/src/sleep.ts';
import {logLastChanceSQLiteCorruptionDiagnostics} from '../db/sqlite-corruption.ts';
import {
  getOrCreateHistogram,
  LONG_DURATION_HISTOGRAM_BOUNDARIES_S,
} from '../observability/metrics.ts';
import {ConfigurationError} from '../types/configuration-error.ts';
import {
  MESSAGE_TYPES,
  singleProcessMode,
  type Message,
  type Subprocess,
  type Worker,
} from '../types/processes.ts';
import {orTimeout} from '../types/timeout.ts';
import {RunningState} from './running-state.ts';
import type {SingletonService} from './service.ts';

/**
 * * `user-facing` workers serve external requests and are the first to
 *   receive a `SIGTERM` or `SIGINT` signal for graceful shutdown.
 *
 * * `supporting` workers support `user-facing` workers and are sent
 *   the `SIGTERM` signal only after all `user-facing` workers have
 *   exited.
 *
 * For other kill signals, such as `SIGQUIT` and `SIGABRT`, all workers
 * are stopped without draining. `SIGQUIT` is used to represent an
 * intentional shutdown (for which draining is not beneficial), whereas
 * `SIGABRT` is used for unexpected process exits.
 *
 * A clean exit (i.e. code 0) of a worker of either type that is not the
 * result of a drain is treated as an intentional shutdown of the server.
 */
export type WorkerType = 'user-facing' | 'supporting';

export const GRACEFUL_SHUTDOWN = ['SIGTERM', 'SIGINT'] as const;

/** The wire form of a shutdown request: a {@link Message} with no payload. */
export const SHUTDOWN_MESSAGE = [
  MESSAGE_TYPES.shutdown,
  {},
] as const satisfies Message<Record<never, never>>;

export const FORCEFUL_SHUTDOWN = ['SIGQUIT', 'SIGABRT'] as const;

type GracefulShutdownSignal = (typeof GRACEFUL_SHUTDOWN)[number];

/**
 * How to stop a child.
 *
 * `ask` is a request the child can drain in response to, delivered over its IPC
 * channel. `terminate` ends the process where it stands. The distinction is a
 * capability of the target, not a property of a signal name: a child with no
 * channel — an external binary this process spawned — can only be terminated, so
 * an `ask` addressed to one degrades to that.
 */
type StopRequest =
  | {readonly kind: 'ask'}
  | {readonly kind: 'terminate'; readonly signal: NodeJS.Signals};

/** The request a signal from outside this process stands for. */
function stopRequestFor(signal: NodeJS.Signals): StopRequest {
  return (GRACEFUL_SHUTDOWN as readonly string[]).includes(signal)
    ? {kind: 'ask'}
    : // `SIGQUIT` and `SIGABRT` mean stop now, without draining, so terminating
      // is the intent rather than a substitute for asking.
      {kind: 'terminate', signal};
}

function isShutdownRequest(data: unknown): boolean {
  return (
    Array.isArray(data) && data.length === 2 && data[0] === SHUTDOWN_MESSAGE[0]
  );
}

function workerStartupMetricName(name: string) {
  if (name === 'zero-cache') {
    return undefined;
  }
  if (name.startsWith('change-streamer')) {
    return 'change_streamer';
  }
  if (name.startsWith('replicator')) {
    if (name.includes('(backup)')) {
      return 'backup_replicator';
    }
    if (name.includes('(serving-copy)')) {
      return 'serving_copy_replicator';
    }
    if (name.includes('(serving)')) {
      return 'serving_replicator';
    }
    return 'other';
  }
  if (name.startsWith('syncer')) {
    return 'syncer';
  }
  if (name.startsWith('reaper')) {
    return 'reaper';
  }
  if (name.startsWith('shadow-syncer')) {
    return 'shadow_syncer';
  }
  if (name.startsWith('mutator')) {
    return 'mutator';
  }
  return 'other';
}

function startupDuration() {
  return getOrCreateHistogram('server', 'startup_duration', {
    description: 'Duration from starting zero-cache to its ready signal.',
    unit: 's',
    bucketBoundaries: LONG_DURATION_HISTOGRAM_BOUNDARIES_S,
  });
}

export function recordStartupDurationMs(durationMs: number) {
  startupDuration().recordMs(durationMs, {component: 'dispatcher'});
}

function workerStartupDuration() {
  return getOrCreateHistogram('server', 'worker_startup_duration', {
    description: 'Duration from starting a worker to its ready signal.',
    unit: 's',
    bucketBoundaries: LONG_DURATION_HISTOGRAM_BOUNDARIES_S,
  });
}

/**
 * How long a drained shutdown waits for its supporting workers before giving up.
 *
 * Inside the grace period a container runtime allows before a SIGKILL: `docker
 * stop` defaults to 10s for Linux containers, and a Kubernetes pod's
 * `terminationGracePeriodSeconds` defaults to 30s. So exceeding this reports and
 * exits rather than being killed mid-shutdown.
 *
 * Note what this budget is NOT: it is not subtracted from a remaining grace
 * period. It is spent after the user-facing drain, so a drain that already used
 * most of a 10s Docker window can still be cut short. Sizing it against the
 * smaller of the two runtimes is the reason it is this low.
 */
const WORKER_STOP_TIMEOUT_MS = 5_000;

/**
 * How long to wait for the closes a SIGKILL should cause, before exiting anyway.
 *
 * Short, because this is confirmation rather than patience: everything that was
 * going to shut down gracefully has already had {@link WORKER_STOP_TIMEOUT_MS}
 * to do it.
 */
const KILL_CONFIRM_TIMEOUT_MS = 1_000;

// An internal error code used to indicate that a message has already been
// logged at level ERRROR. When a process exits with this error code, the
// parent process logs the exit at level WARN instead of ERROR.
export const UNHANDLED_EXCEPTION_ERROR_CODE = 13;

// An internal error code used to indicate that the server should exit
// without draining (e.g. due to a worker exiting cleanly outside of a drain,
// such as for an auto reset), but the exit is otherwise intentional.
export const INTENTIONAL_SHUTDOWN_ERROR_CODE = 14;

/**
 * Handles readiness, termination signals, and coordination of graceful
 * shutdown.
 */
export class ProcessManager {
  readonly #lc: LogContext;
  readonly #userFacing = new Set<Subprocess>();
  readonly #all = new Set<Subprocess>();
  readonly #exitImpl: (code: number) => never;
  readonly #start = Date.now();
  readonly #ready: Promise<void>[] = [];

  readonly #closed = new Map<Subprocess, Promise<void>>();

  /**
   * Set once the remaining workers have been asked to stop and are being waited
   * for, so their exits do not each try to end the process.
   */
  #stopping = false;
  /** Whether the wait escalated to SIGKILL, so nothing should signal again. */
  #terminated = false;

  #runningState = new RunningState('process-manager');
  #drainStart = 0;

  constructor(lc: LogContext, proc: EventEmitter) {
    this.#lc = lc.withContext('component', 'process-manager');

    // Propagate `SIGTERM` and `SIGINT` to all user-facing workers,
    // initiating a graceful shutdown. The parent process will
    // exit once all user-facing workers have exited ...
    for (const signal of GRACEFUL_SHUTDOWN) {
      proc.on(signal, () => this.#startDrain(signal));
    }

    // The same drain, asked for rather than signalled. This is how a parent stops
    // its own children (see `#stop`), and the only way to ask at all on Windows,
    // where Node delivers no signals to a process: a `kill()` there is an immediate
    // termination that runs none of this and leaves the workers below orphaned,
    // still holding their files and connections. Signals stay the external contract
    // for operators and container runtimes.
    proc.on('message', (data: unknown) => {
      if (isShutdownRequest(data)) {
        this.#lc.info?.('received shutdown request');
        this.#startDrain('SIGTERM');
      }
    });

    // ... which will result in sending `SIGTERM` to the remaining workers.
    proc.on('exit', code => {
      if (this.#terminated) {
        // These workers were already SIGKILLed by the wait, so signalling again
        // on the way out reaches a process that is gone. Gated on the escalation
        // having happened rather than on `#stopping`, because a forceful exit
        // arriving DURING the wait still has to terminate what is left — and not
        // on the exit code, which cannot tell the wait's own forced exit from an
        // external abort.
        return;
      }
      // Always a signal, never an ask: this runs from inside `process.exit()`,
      // where there is no loop left to flush an IPC message. The ask belongs to
      // the bounded wait, which is still running when it sends one.
      this.#stop(this.#all, {
        kind: 'terminate',
        signal:
          code === 0
            ? 'SIGTERM' // graceful, drained shutdown
            : code === INTENTIONAL_SHUTDOWN_ERROR_CODE
              ? 'SIGQUIT' // intentional abort without drain
              : 'SIGABRT', // unintentional shutdown, alertable error
      });
    });

    // For other (catchable) kill signals, exit with a non-zero error code
    // to send a `SIGQUIT` (intentional shutdown) or `SIGABRT` (unexpected
    // shutdown) to all workers. For these signals, workers are stopped
    // immediately without draining, since there is no merit to slowly draining
    // when supporting workers have stopped.
    //
    // The logic for handling these signals is in `runUntilKilled()`.
    for (const signal of FORCEFUL_SHUTDOWN) {
      proc.on(signal, () =>
        this.#exit(signal === 'SIGQUIT' ? INTENTIONAL_SHUTDOWN_ERROR_CODE : -1),
      );
    }

    // Captured here rather than read at exit time. How this manager ends is a
    // property of how it was started, and re-reading it later lets an unrelated
    // change of the environment turn what should be an in-process exit into a real
    // one — which, for an exit that happens a tick after a drain rather than
    // inside it, means calling `process.exit()` in a test runner's worker and
    // taking the worker with it.
    const exitsInProcess = singleProcessMode();
    this.#exitImpl = (code: number) => {
      if (exitsInProcess) {
        return proc.emit('exit', code) as never; // For unit / integration tests.
      }
      process.exit(code);
    };
  }

  async shutdown() {
    if (this.#drainStart === 0) {
      this.#startDrain(GRACEFUL_SHUTDOWN[0]);
    }
    await this.#runningState.stopped();
  }

  /**
   * Stops the workers that are left and exits once they are gone.
   *
   * Reached when the user-facing workers have drained, leaving the supporting ones
   * — the replicator among them. Exiting first and stopping them from the `exit`
   * handler on the way out means nothing waits for them, so a caller that observes
   * this process closing can still be racing a replicator that holds the replica
   * file open. POSIX hides that completely, because unlink-while-open is legal
   * there: a caller can delete a file a live worker still has open and see it
   * succeed. Windows refuses, which is where the race became visible.
   *
   * Bounded, because a shutdown that waits without a limit is worse than one that
   * gives up: a wedged worker would hold the process past whatever grace period a
   * container runtime allows, and it would be killed mid-shutdown rather than
   * completing one. Past the deadline this says so and exits anyway.
   */
  #exitWhenWorkersHaveStopped(code: number) {
    if (this.#stopping) {
      // Already waiting. Re-entering would re-ask every worker, arm a second
      // deadline and exit twice.
      return undefined;
    }
    if (this.#all.size === 0) {
      return this.#exit(code);
    }
    this.#stopping = true;

    const remaining = [...this.#all];
    // Every tracked worker has a close promise; `addSubprocess` records one for
    // each, and the 'close' handler removes it from both maps together.
    const pending = remaining.map(worker => must(this.#closed.get(worker)));
    this.#lc.info?.(`stopping ${remaining.length} supporting worker(s)`);
    this.#stop(this.#all, {kind: 'ask'});

    // Referenced deliberately: if a wedged worker's channel is the only thing
    // holding the loop open, an unreferenced timer would let the process exit on
    // an empty loop with Node's code instead of this drain's.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<'timeout'>(resolve => {
      timer = setTimeout(resolve, WORKER_STOP_TIMEOUT_MS, 'timeout');
    });
    void Promise.race([
      Promise.all(pending).then(() => 'stopped' as const),
      deadline,
    ])
      .then(async outcome => {
        if (outcome === 'stopped') {
          return code;
        }
        this.#lc.warn?.(
          `terminating ${this.#all.size} worker(s) still running after ` +
            `${WORKER_STOP_TIMEOUT_MS} ms`,
        );
        // The ask went unanswered, so escalate to the one thing that ends a
        // process on every platform. Without this the wait expires and this
        // process exits leaving those workers running — still holding the
        // replica, which is the outcome the wait exists to prevent.
        this.#terminated = true;
        this.#stop(this.#all, {kind: 'terminate', signal: 'SIGKILL'});
        // A signal is asynchronous, so exiting in the same turn would assert
        // nothing about whether it landed. Wait for the closes it should cause,
        // bounded again so a worker that survives SIGKILL cannot hold the exit.
        await Promise.race([
          Promise.all(pending),
          sleep(KILL_CONFIRM_TIMEOUT_MS),
        ]);
        // A drain that had to kill did not complete, so it does not report the
        // code a completed one would.
        return code === 0 ? INTENTIONAL_SHUTDOWN_ERROR_CODE : code;
      })
      .then(exitCode => {
        clearTimeout(timer);
        this.#exit(exitCode);
      });
  }

  #exit(code: number) {
    this.#lc.info?.('exiting with code', code);
    this.#runningState.stop(this.#lc);
    void this.#lc.flush().finally(() => this.#exitImpl(code));
  }

  #startDrain(signal: GracefulShutdownSignal) {
    if (this.#all.size === 0) {
      // Shutdown if a signal is received before any subprocesses are added.
      this.#lc.info?.(`exiting on ${signal}`);
      this.#exit(0);
    }
    this.#lc.info?.(`initiating drain (${signal})`);
    this.#drainStart = Date.now();
    const request = stopRequestFor(signal);
    if (this.#userFacing.size) {
      this.#stop(this.#userFacing, request);
    } else {
      this.#stop(this.#all, request);
    }
  }

  addSubprocess(proc: Subprocess, type: WorkerType, name: string) {
    if (type === 'user-facing') {
      this.#userFacing.add(proc);
    }
    this.#all.add(proc);

    // Tracked so a drained shutdown can wait for this worker rather than exiting
    // out from under it; see #exitWhenWorkersHaveStopped.
    const closed = resolver<void>();
    this.#closed.set(proc, closed.promise);

    let isOpen = true;
    proc.on('close', (code, signal) => {
      isOpen = false;
      closed.resolve();
      this.#closed.delete(proc);
      this.#onExit(code, signal, null, type, name, proc);
    });

    // As per https://nodejs.org/api/child_process.html#event-error
    // 'error' events can happen when sending a message to a child process
    // fails. This is not really an error when the server is shutting down,
    // so log any post-close errors at 'warn'.
    proc.on('error', err =>
      this.#lc[!isOpen || this.#drainStart > 0 ? 'warn' : 'error']?.(
        `error from ${name} ${proc.pid}`,
        err,
      ),
    );
  }

  readonly #initializing = new Map<number, string>();
  #nextID = 0;

  addWorker(worker: Worker, type: WorkerType, name: string): Worker {
    this.addSubprocess(worker, type, name);

    const start = performance.now();
    const id = ++this.#nextID;
    this.#initializing.set(id, name);
    const {promise, resolve} = resolver();
    this.#ready.push(promise);

    worker.onceMessageType('ready', () => {
      const elapsed = performance.now() - start;
      const workerMetricName = workerStartupMetricName(name);
      if (workerMetricName) {
        workerStartupDuration().recordMs(elapsed, {
          worker: workerMetricName,
          type,
        });
      }
      this.#lc.debug?.(`${name} ready (${Date.now() - this.#start} ms)`);
      this.#initializing.delete(id);
      resolve();
    });

    return worker;
  }

  initializing(): string[] {
    return [...this.#initializing.values()];
  }

  async allWorkersReady() {
    await Promise.all(this.#ready);
  }

  logErrorAndExit(err: unknown, name: string) {
    // only accessible by the main (i.e. user-facing) process.
    this.#onExit(-1, null, err, 'user-facing', name, undefined);
  }

  #onExit(
    code: number,
    sig: NodeJS.Signals | null,
    err: unknown,
    type: WorkerType,
    name: string,
    worker: Subprocess | undefined,
  ) {
    // Remove the worker from maps to avoid attempting to send more signals to it.
    if (worker) {
      this.#userFacing.delete(worker);
      this.#all.delete(worker);
    }

    const pid = worker?.pid ?? process.pid;

    // A clean exit outside of a drain is an intentional shutdown, e.g. the
    // replication-manager shutting down for protocol-specific instructions
    // (like auto reset), or a configuration error. In this case, a special
    // error code is used to signal that the server should be shut down
    // without draining, but it is otherwise not considered an
    // unexpected/alertable error. The same applies to a supporting worker
    // that exits while user-facing workers are still draining.
    if (
      code === 0 &&
      (this.#drainStart === 0 ||
        (type === 'supporting' && this.#userFacing.size > 0))
    ) {
      code = INTENTIONAL_SHUTDOWN_ERROR_CODE;
    }

    if (type === 'supporting') {
      const log =
        code === 0 || code === INTENTIONAL_SHUTDOWN_ERROR_CODE
          ? 'info'
          : 'warn';
      this.#lc[log]?.(`${name} (${pid}) exited with code (${code})`, err ?? '');
      if (this.#stopping) {
        // Already waiting for these to finish. Exiting on the first one to close
        // would abandon its siblings — which is the whole point of the wait, since
        // one of them is the replicator and it still holds the replica file.
        return;
      }
      if (this.#drainStart > 0 && this.#all.size > 0) {
        // A manager whose workers are ALL supporting never reaches the
        // user-facing branch below, so without this it exits on the first close
        // and signals the rest from inside `process.exit()`. The replication
        // manager is that shape — it runs with no syncers — and it is the one
        // holding the backup replica and litestream.
        return this.#exitWhenWorkersHaveStopped(code);
      }
      return this.#exit(code);
    }

    const log =
      code === 0 || code === INTENTIONAL_SHUTDOWN_ERROR_CODE
        ? 'info'
        : this.#drainStart > 0 || code === UNHANDLED_EXCEPTION_ERROR_CODE
          ? 'warn'
          : 'error';
    this.#lc[log]?.(
      sig
        ? `${name} (${pid}) killed with (${sig})`
        : `${name} (${pid}) exited with code (${code})`,
      err ?? '',
    );

    // user-facing workers exited or finished draining.
    if (this.#userFacing.size === 0) {
      this.#lc.info?.(
        this.#drainStart
          ? `all user-facing workers drained (${
              Date.now() - this.#drainStart
            } ms)`
          : `all user-facing workers exited`,
      );
      return this.#exitWhenWorkersHaveStopped(this.#drainStart ? 0 : code);
    }

    if (this.#drainStart === 0) {
      // If a user-facing worker exits without receiving a drain signal,
      // shutdown the server.
      return this.#exit(code);
    }

    return undefined;
  }

  #stop(workers: Iterable<Subprocess>, request: StopRequest) {
    for (const worker of workers) {
      stopSubprocess(this.#lc, worker, request);
    }
  }
}

/**
 * Delivers `request` to `proc`. An `ask` goes over the IPC channel on every
 * platform, because a signal does not ask anything portably: Node delivers none
 * to a process on Windows, where `kill('SIGTERM')` terminates the child where
 * it stands, undrained and still holding its files. Signals stay the contract
 * for operators and container runtimes. A child without a channel - an external
 * binary such as litestream, which has no drain to run - is signalled instead.
 */
function stopSubprocess(
  lc: LogContext,
  proc: Subprocess,
  request: StopRequest,
): void {
  try {
    if (request.kind === 'ask' && proc.send && proc.connected) {
      proc.send([...SHUTDOWN_MESSAGE]);
    } else {
      proc.kill(
        request.kind === 'terminate' ? request.signal : GRACEFUL_SHUTDOWN[0],
      );
    }
  } catch (e) {
    lc.error?.(e);
  }
}

/**
 * Runs the supporting subprocesses of a worker (e.g. the litestream process
 * of the backup-replicator) as a {@link SingletonService}.
 *
 * Unlike a {@link ProcessManager}, it does not forward `SIGTERM` or `SIGINT`
 * to its subprocesses. Instead, {@link runUntilKilled} stops it along with the
 * worker's other services, i.e. after they have drained, so that the
 * subprocesses keep supporting them until then. Stopping asks a subprocess
 * with an IPC channel (the backup-replicator) to shut down, and signals one
 * without (litestream). Forceful signals (`SIGQUIT`
 * and `SIGABRT`), on the other hand, are forwarded immediately once the
 * service is running, and the subprocesses are killed if the worker exits
 * before they are stopped.
 *
 * `run()` settles when a subprocess exits before {@link stop()} is called,
 * which stops the worker: a clean exit resolves (and the parent in turn treats
 * the worker's clean exit outside of a drain as an intentional shutdown),
 * while any other exit rejects.
 */
export class SupportingProcesses implements SingletonService {
  readonly id = 'supporting-processes';
  readonly #lc: LogContext;
  readonly #parent: EventEmitter;
  readonly #procs = new Map<Subprocess, string>();
  readonly #done = resolver<void>();
  #signaled: NodeJS.Signals | undefined;

  constructor(lc: LogContext, parent: EventEmitter) {
    this.#lc = lc.withContext('component', 'supporting-processes');
    this.#parent = parent;
    // run() may never be called if the worker fails before running services.
    this.#done.promise.catch(() => {});

    parent.on('exit', code =>
      this.#kill(
        code === 0
          ? 'SIGTERM'
          : code === INTENTIONAL_SHUTDOWN_ERROR_CODE
            ? 'SIGQUIT'
            : 'SIGABRT',
      ),
    );
  }

  add<P extends Subprocess>(proc: P, name: string): P {
    this.#procs.set(proc, name);
    proc.on('close', (code: number | null, sig: NodeJS.Signals | null) =>
      this.#onClose(proc, name, code, sig),
    );
    // As with the ProcessManager, 'error' events after a signal (e.g. failing
    // to send a message to an exiting process) are logged at 'warn'.
    proc.on('error', err =>
      this.#lc[this.#signaled ? 'warn' : 'error']?.(
        `error from ${name} ${proc.pid}`,
        err,
      ),
    );
    return proc;
  }

  run(): Promise<void> {
    // Signal listeners are only installed when running, i.e. alongside those
    // of runUntilKilled(). Installing them any earlier would consume signals
    // received during worker initialization, which would otherwise terminate
    // the worker (or be handled by the initialization logic).
    for (const signal of FORCEFUL_SHUTDOWN) {
      this.#parent.on(signal, () => this.#kill(signal));
    }
    return this.#done.promise;
  }

  async stop(): Promise<void> {
    if (!this.#signaled) {
      this.#signaled = 'SIGTERM';
      for (const proc of this.#procs.keys()) {
        stopSubprocess(this.#lc, proc, {kind: 'ask'});
      }
    }
    if (this.#procs.size === 0) {
      this.#done.resolve();
    }
    await this.#done.promise.catch(() => {});
  }

  #onClose(
    proc: Subprocess,
    name: string,
    code: number | null,
    sig: NodeJS.Signals | null,
  ) {
    this.#procs.delete(proc);
    const exit = sig
      ? `${name} (${proc.pid}) killed with (${sig})`
      : `${name} (${proc.pid}) exited with code (${code})`;

    if (this.#signaled) {
      this.#lc.info?.(exit);
      if (this.#procs.size === 0) {
        this.#done.resolve();
      }
    } else if (code === 0 || code === INTENTIONAL_SHUTDOWN_ERROR_CODE) {
      this.#lc.info?.(exit);
      this.#done.resolve();
    } else {
      this.#done.reject(new Error(exit));
    }
  }

  #kill(signal: NodeJS.Signals) {
    this.#signaled = signal;
    for (const proc of this.#procs.keys()) {
      stopSubprocess(this.#lc, proc, {kind: 'terminate', signal});
    }
  }
}

export type SelfDrainOptions = {
  /**
   * The time after a self drain is requested at which the server sends itself
   * a `SIGTERM`, unless one was received sooner (e.g. from the container
   * runner).
   */
  delayMs: number;

  /**
   * Called when a self drain is requested. This should fail health checks
   * (both readiness and liveness) so that the container runner stops routing
   * to the server and initiates its normal shutdown process.
   */
  onRequested: () => void;
};

/**
 * Coordinates a drain that is initiated by the server itself (e.g. by a
 * view-syncer that has been granted permission to restore a new replica),
 * as opposed to one initiated by the container runner with a `SIGTERM`.
 *
 * Health checks start failing immediately, upon which an orchestrator such
 * as Kubernetes stops routing to the server and shuts it down as usual
 * (i.e. running any pre-stop hooks before sending `SIGTERM`). As a backstop,
 * and for environments without liveness checks, the server sends itself a
 * `SIGTERM` after the configured delay.
 */
export class SelfDrain {
  readonly #lc: LogContext;
  readonly #proc: EventEmitter;
  readonly #delayMs: number;
  readonly #onRequested: () => void;
  #requested = false;
  #signaled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(lc: LogContext, proc: EventEmitter, opts: SelfDrainOptions) {
    this.#lc = lc.withContext('component', 'self-drain');
    this.#proc = proc;
    this.#delayMs = opts.delayMs;
    this.#onRequested = opts.onRequested;

    for (const signal of GRACEFUL_SHUTDOWN) {
      proc.once(signal, () => {
        this.#signaled = true;
        clearTimeout(this.#timer);
      });
    }
  }

  request() {
    if (this.#requested || this.#signaled) {
      return; // Already draining.
    }
    this.#requested = true;
    this.#lc.info?.(
      `self drain requested. sending SIGTERM in ${this.#delayMs} ms`,
    );
    this.#onRequested();
    this.#timer = setTimeout(() => {
      if (!this.#signaled) {
        this.#lc.info?.(`initiating self drain`);
        this.#proc.emit('SIGTERM', 'SIGTERM');
      }
    }, this.#delayMs);
  }
}

/**
 * The event that a {@link PreDrain} emits immediately upon the first graceful
 * shutdown signal, with that signal as its argument, before the delay.
 */
export const PRE_DRAIN = 'preDrain';

/**
 * Delays graceful shutdown signals (`SIGTERM`, `SIGINT`), e.g. so that load
 * balancers can observe a failed readiness check before the server begins
 * to drain. The first graceful signal is announced immediately with a
 * {@link PRE_DRAIN} event, and is re-emitted to listeners of the signal, such
 * as those of the {@link ProcessManager} and {@link runUntilKilled}, once the
 * delay has elapsed. Repeated graceful signals are dropped. All other events,
 * including forceful signals, are forwarded immediately.
 */
export class PreDrain extends NodeEventEmitter {
  readonly #lc: LogContext;
  readonly #proc: EventEmitter;
  readonly #delayMs: number;
  readonly #forwarded = new Set<string | symbol>(['newListener', PRE_DRAIN]);
  #signaled = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(lc: LogContext, proc: EventEmitter, delayMs: number) {
    super();
    this.#lc = lc.withContext('component', 'pre-drain');
    this.#proc = proc;
    this.#delayMs = delayMs;

    for (const signal of GRACEFUL_SHUTDOWN) {
      this.#forwarded.add(signal);
      proc.on(signal, () => this.#onGracefulSignal(signal));
    }
    this.on('newListener', (event: string | symbol) => this.#forward(event));
  }

  #forward(event: string | symbol) {
    if (this.#forwarded.has(event)) {
      return;
    }
    this.#forwarded.add(event);
    this.#proc.on(event, (...args: unknown[]) => {
      if (
        event === 'disconnect' ||
        (FORCEFUL_SHUTDOWN as readonly (string | symbol)[]).includes(event)
      ) {
        clearTimeout(this.#timer); // Stopping without a drain.
      }
      this.emit(event, ...args);
    });
  }

  #onGracefulSignal(signal: GracefulShutdownSignal) {
    if (this.#signaled) {
      this.#lc.info?.(`already shutting down. ignoring ${signal}`);
      return;
    }
    this.#signaled = true;
    this.#lc.info?.(`received ${signal}. draining in ${this.#delayMs} ms`);
    this.emit(PRE_DRAIN, signal);
    this.#timer = setTimeout(() => this.emit(signal, signal), this.#delayMs);
  }
}

/**
 * The maximum time that {@link runUntilKilled} waits for its services to stop
 * (i.e. for their `run()` to settle) after stopping them.
 */
export const STOP_TIMEOUT_MS = 60_000;

/**
 * A signal that aborts when the manager asks this worker to shut down over its
 * IPC channel, which is how a parent asks where it cannot signal: Node delivers
 * no signals on Windows.
 *
 * Armed before the worker's startup and consumed by {@link runUntilKilled}. A
 * `'message'` event reaches the listeners that exist when it arrives and is not
 * replayed for one added later, so a request that lands while startup blocks -
 * a view-syncer restoring its replica waits for the replication-manager to
 * publish a backup - would otherwise be discarded and never honoured.
 * Long-running startup work races this signal.
 */
export function shutdownRequested(parent: EventEmitter): AbortSignal {
  const controller = new AbortController();
  parent.on('message', (data: unknown) => {
    if (isShutdownRequest(data)) {
      controller.abort();
    }
  });
  return controller.signal;
}

/**
 * Runs the specified services, stopping them on `SIGTERM` or `SIGINT`, or
 * when the manager asks over IPC, with an optional
 * {@link SingletonService.drain drain()}, or stopping them without draining for
 * `SIGQUIT`, or when the parent process disconnects. Repeated graceful requests
 * are ignored. If a service stops (or throws) on its own, the remaining
 * services are stopped without draining.
 *
 * @param shutdown from {@link shutdownRequested}, armed by the caller before
 *     its startup so that a request arriving during it is not lost. If one
 *     already arrived, the services are not started.
 * @returns a Promise that settles once all services have stopped (or
 *          {@link STOP_TIMEOUT_MS} has elapsed), resolving or rejecting
 *          with the outcome of the first service to stop.
 */
export async function runUntilKilled(
  lc: LogContext,
  parent: EventEmitter,
  shutdown: AbortSignal,
  ...services: SingletonService[]
): Promise<void> {
  if (services.length === 0) {
    return;
  }
  // Already requested, during the caller's startup: not starting the services
  // is the shutdown. Stopping a service that never ran is not a no-op, since a
  // `stop()` that waits on what its `run()` assigns would race the `run()`.
  if (shutdown.aborted) {
    lc.info?.('shutdown requested before services started; not starting them');
    return;
  }
  const stopped = new Set<SingletonService>();
  const runs = services.map(svc => svc.run().finally(() => stopped.add(svc)));

  const allStopped = resolver<void>();
  let stopping: Promise<void> | undefined;
  const stopAll = (reason: string) =>
    (stopping ??= stopServices(lc, services, runs, stopped, reason).then(
      allStopped.resolve,
    ));

  const GRACEFUL_SIGNALS = GRACEFUL_SHUTDOWN as readonly NodeJS.Signals[];
  let draining = false;
  const onSignal = async (signal: NodeJS.Signals) => {
    if (GRACEFUL_SIGNALS.includes(signal)) {
      if (draining || stopping) {
        // e.g. A SIGINT from both the terminal and a wrapping process.
        lc.info?.(`already shutting down. ignoring ${signal}`);
        return;
      }
      draining = true;
      // Drain all services before stopping any of them. Stopping a service
      // resolves its run() and thus ends runUntilKilled(), so a service
      // without a drain() must not be stopped while others are draining.
      const results = await Promise.allSettled(
        services.map(async svc => {
          if (svc.drain) {
            lc.info?.(`draining ${svc.constructor.name} ${svc.id} (${signal})`);
            await svc.drain();
          }
        }),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          lc.warn?.(`error while draining (${signal})`, result.reason);
        }
      }
    }
    // A forceful signal stops the services without waiting for (or after)
    // a drain.
    await stopAll(signal);
  };
  // The listeners remain installed for the lifetime of the process, as a
  // signal without a listener would terminate the process (e.g. a repeated
  // SIGINT during a drain).
  for (const signal of [...GRACEFUL_SHUTDOWN, ...FORCEFUL_SHUTDOWN]) {
    parent.on(signal, () => void onSignal(signal));
  }
  // A forked worker whose parent has exited (e.g. was killed by a signal,
  // in which case it cannot signal its workers) stops without draining, so
  // that it (and in turn its own subprocesses) is not orphaned.
  parent.once('disconnect', () => {
    lc.warn?.(`parent process disconnected. stopping without draining`);
    void stopAll('disconnect');
  });

  // The manager's request over IPC drains like a SIGTERM.
  shutdown.addEventListener(
    'abort',
    () => void onSignal(GRACEFUL_SHUTDOWN[0]),
    {once: true},
  );

  try {
    // Run all services and resolve when any of them stops, or when stopping
    // them (after a signal) has timed out.
    const svc = await Promise.race([
      ...runs.map((run, i) => run.then(() => services[i])),
      allStopped.promise,
    ]);
    if (svc) {
      lc.info?.(`${svc.constructor.name} (${svc.id}) stopped`);
    }
  } catch (e) {
    lc.error?.(`exiting on error`, e);
    throw e;
  } finally {
    await stopAll('stopped');
  }
}

async function stopServices(
  lc: LogContext,
  services: SingletonService[],
  runs: Promise<void>[],
  stopped: Set<SingletonService>,
  reason: string,
) {
  for (const svc of services) {
    if (!stopped.has(svc)) {
      lc.info?.(`stopping ${svc.constructor.name} ${svc.id} (${reason})`);
      void svc
        .stop()
        .catch(e =>
          lc.warn?.(`error stopping ${svc.constructor.name} ${svc.id}`, e),
        );
    }
  }
  if (
    (await orTimeout(Promise.allSettled(runs), STOP_TIMEOUT_MS)) === 'timed-out'
  ) {
    const running = services.filter(svc => !stopped.has(svc));
    lc.warn?.(
      `services did not stop within ${STOP_TIMEOUT_MS} ms: ` +
        running.map(svc => `${svc.constructor.name} ${svc.id}`).join(', '),
    );
  }
}

export async function exitAfter(
  logContext: LogContext | (() => LogContext),
  run: () => Promise<void>,
) {
  const getLogContext =
    typeof logContext === 'function' ? logContext : () => logContext;
  try {
    await run();
    const lc = getLogContext();
    lc.info?.(`pid ${pid} exiting normally`);
    process.exit(0);
  } catch (e) {
    const lc = getLogContext();
    if (e instanceof ConfigurationError) {
      lc.error?.(`exiting with configuration error: ${String(e)}`, e);
      process.exit(0);
    }
    if (e instanceof AbortError) {
      // AbortErrors signal an intentional shutdown or restart (e.g. SIGTERM
      // during a rollout, AutoResetSignal) and should not raise alerts. The
      // non-zero exit code is kept so that restart semantics are unchanged.
      lc.warn?.(`exiting after abort: ${String(e)}`, e);
    } else {
      lc.error?.(`exiting with error: ${String(e)}`, e);
    }
    try {
      logLastChanceSQLiteCorruptionDiagnostics(lc, e);
    } catch (diagnosticError) {
      lc.error?.('SQLite corruption last-chance diagnostic failed', {
        error: diagnosticError,
      });
    }
    try {
      await lc.flush();
    } finally {
      process.exit(-1);
    }
  }
}

/**
 * The HeartbeatMonitor monitors the cadence heartbeats (e.g. "/keepalive"
 * health checks made to HttpServices) that signal that the server
 * should continue processing requests. When a configurable `stopInterval`
 * elapses without receiving these heartbeats, the monitor initiates a
 * graceful shutdown of the server. This works with common load balancing
 * frameworks such as AWS Elastic Load Balancing.
 *
 * The HeartbeatMonitor is **opt-in** in that it only kicks in after it
 * starts receiving keepalives.
 */
export class HeartbeatMonitor {
  readonly #stopInterval: number;
  readonly #proc: EventEmitter;

  #lc: LogContext;
  #checkIntervalTimer: NodeJS.Timeout | undefined;
  #checkImmediateTimer: NodeJS.Immediate | undefined;
  #lastHeartbeat = 0;

  constructor(
    lc: LogContext,
    stopInterval: number,
    proc: EventEmitter = process,
  ) {
    this.#lc = lc;
    this.#stopInterval = stopInterval;
    this.#proc = proc;
  }

  onHeartbeat(reqHeaders: IncomingHttpHeaders) {
    this.#lastHeartbeat = Date.now();
    if (this.#checkIntervalTimer === undefined) {
      this.#lc.info?.(
        `starting heartbeat monitor at ${
          this.#stopInterval / 1000
        } second interval`,
        reqHeaders,
      );
      // e.g. check every 5 seconds to see if it's been over 20 seconds
      //      since the last heartbeat.
      this.#checkIntervalTimer = setInterval(
        this.#checkStopInterval,
        this.#stopInterval / 4,
      );
    }
  }

  #checkStopInterval = () => {
    // In the Node.js event loop, timers like setInterval and setTimeout
    // run *before* I/O events coming from network sockets or file reads/writes.
    // When this process gets starved of CPU resources for long periods of time,
    // for example when other processes are monopolizing all available cores,
    // pathological behavior can emerge:
    // - keepalive network request comes in, but is queued in Node internals waiting
    //   for time on the event loop
    // - CPU is starved/monopolized by other processes for longer than the time
    //   configured via this.#stopInterval
    // - When CPU becomes available and the event loop wakes up, this stop interval
    //   check is run *before* the keepalive request is processed. The value of
    //   this.#lastHeartbeat is now very stale, and erroneously triggers a shutdown
    //   even though keepalive requests were about to be processed and update
    //   this.#lastHeartbeat. Downtime ensues.
    //
    // To avoid this, we push the check out to a phase of the event loop *after*
    // I/O events are processed, using setImmediate():
    // https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick#setimmediate-vs-settimeout
    //
    // This ensures we see a value for this.#lastHeartbeat that reflects
    // any keepalive requests that came in during the current event loop turn.
    this.#checkImmediateTimer = setImmediate(() => {
      this.#checkImmediateTimer = undefined;
      const timeSinceLastHeartbeat = Date.now() - this.#lastHeartbeat;
      if (timeSinceLastHeartbeat >= this.#stopInterval) {
        this.#lc.info?.(
          `last heartbeat received ${
            timeSinceLastHeartbeat / 1000
          } seconds ago. draining.`,
        );
        // Emitted on this process rather than sent to it. `process.kill(
        // process.pid, 'SIGTERM')` is not a way to ask this process for
        // anything: libuv maps the terminating signals to `TerminateProcess` on
        // Windows, so no handler runs and the drain this log line announces
        // never happens — the process is simply gone, mid-request. Emitting
        // reaches the manager's own listener on every platform.
        this.#proc.emit(GRACEFUL_SHUTDOWN[0]);
      }
    });
  };

  stop() {
    clearTimeout(this.#checkIntervalTimer);
    if (this.#checkImmediateTimer) {
      clearImmediate(this.#checkImmediateTimer);
    }
  }
}
