import type {IncomingHttpHeaders} from 'node:http';
import {pid} from 'node:process';
import type {EventEmitter} from 'stream';
import type {LogContext} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import {must} from '../../../shared/src/must.ts';
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

// An internal error code used to indicate that a message has already been
// logged at level ERRROR. When a process exits with this error code, the
// parent process logs the exit at level WARN instead of ERROR.
export const UNHANDLED_EXCEPTION_ERROR_CODE = 13;

// An internal error code used to indicate that the server should exit
// without draining (e.g. due to a supporting worker get a signal to shut
// down), but the exit is otherwise intentional.
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
    // its own children (see `#kill`), and the only way to ask at all on Windows,
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
      if (this.#stopping) {
        // The drain already asked these workers and escalated past its deadline,
        // so asking again on the way out would re-signal a worker that has
        // already been terminated.
        return;
      }
      this.#stop(
        this.#all,
        code === 0
          ? {kind: 'ask'} // graceful, drained shutdown
          : {
              kind: 'terminate',
              signal:
                code === INTENTIONAL_SHUTDOWN_ERROR_CODE
                  ? 'SIGQUIT' // intentional abort without drain
                  : 'SIGABRT', // unintentional shutdown, alertable error
            },
      );
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
    void Promise.race([Promise.all(pending).then(() => 'stopped'), deadline])
      .then(outcome => {
        if (outcome === 'timeout') {
          this.#lc.warn?.(
            `terminating ${this.#all.size} worker(s) still running after ` +
              `${WORKER_STOP_TIMEOUT_MS} ms`,
          );
          // The ask went unanswered, so escalate to the one thing that ends a
          // process on every platform. Without this the wait expires and this
          // process exits leaving those workers running — still holding the
          // replica, which is the outcome the wait exists to prevent.
          this.#stop(this.#all, {kind: 'terminate', signal: 'SIGKILL'});
        }
      })
      .finally(() => {
        clearTimeout(timer);
        this.#exit(code);
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

    if (type === 'supporting') {
      // Supporting workers like the replication-manager shut down without a
      // drain signal when receiving protocol-specific instructions (like auto
      // reset). In this case, a special error code is used to signal that the
      // server should be shut down without draining, but it is otherwise not
      // considered an unexpected/alertable error.
      if (code === 0 && (this.#drainStart === 0 || this.#userFacing.size > 0)) {
        code = INTENTIONAL_SHUTDOWN_ERROR_CODE;
      }
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
      return this.#exitWhenWorkersHaveStopped(
        this.#drainStart ? 0 : code || -1,
      );
    }

    if (this.#drainStart === 0) {
      // If a user-facing worker exits without receiving a drain signal,
      // shutdown the server.
      return this.#exit(code || -1);
    }

    return undefined;
  }

  /**
   * Delivers `request` to each worker.
   *
   * An `ask` goes over the IPC channel, on every platform. A signal is not a
   * portable way to request anything: Node delivers none to a process on Windows,
   * so `kill('SIGTERM')` there terminates a worker where it stands — it never
   * drains, never releases what it holds, and never propagates to workers of its
   * own. Asking over the channel takes the same path everywhere, so no branch
   * goes untested wherever CI runs. Signals remain the EXTERNAL contract, because
   * that is what an operator and a container runtime send; they are just not how
   * this process talks to its own children.
   *
   * A worker with no channel cannot be asked, so it is terminated instead. That
   * is not a fallback for a fork: `send` is absent only on a child spawned
   * without IPC, which here means an external binary (litestream) that has no
   * drain to run.
   */
  #stop(workers: Iterable<Subprocess>, request: StopRequest) {
    for (const worker of workers) {
      try {
        if (request.kind === 'ask' && worker.send && worker.connected) {
          worker.send([...SHUTDOWN_MESSAGE]);
        } else {
          worker.kill(
            request.kind === 'terminate'
              ? request.signal
              : GRACEFUL_SHUTDOWN[0],
          );
        }
      } catch (e) {
        this.#lc.error?.(e);
      }
    }
  }
}

/**
 * A signal that aborts when the manager asks this worker to shut down, armed
 * before the worker has any services to stop.
 *
 * Armed once per worker, and {@link runUntilKilled} consumes the signal rather
 * than listening itself. Arming has to happen before startup, because a worker
 * whose startup blocks would otherwise never reach a
 * listener: a view-syncer restoring its replica waits for the replication-manager
 * to publish a restorable backup, which this repo documents as taking many
 * minutes. A request arriving in that window is held by the IPC channel and
 * delivered once a listener appears — but nothing in the startup path has any
 * reason to finish, so the worker never reaches the listener that would honour
 * it. Breaking that wait is what a signal used to do; a worker that cannot be
 * asked to stop while starting up is a worker the manager cannot stop at all,
 * and it exits leaving that worker holding the replica file.
 *
 * Long-running startup work therefore races this signal, so a request is
 * honoured at the point it arrives rather than at the point the worker would
 * have been ready to hear it.
 */
export function shutdownRequested(parent: EventEmitter): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();

  // Both transports, for the same reason runUntilKilled listens for both: a
  // signal is how an operator or container runtime asks, an IPC message is how
  // the manager asks where signals are not delivered.
  for (const signal of GRACEFUL_SHUTDOWN) {
    parent.once(signal, abort);
  }
  parent.on('message', (data: unknown) => {
    if (isShutdownRequest(data)) {
      abort();
    }
  });

  return controller.signal;
}

/**
 * Runs the specified services, stopping them when the manager asks with an
 * optional {@link SingletonService.drain drain()}, or stopping them without
 * draining for `SIGQUIT` and `SIGABRT`.
 *
 * @param shutdown from {@link shutdownRequested}, taken rather than armed here.
 *     A request can arrive before this call: a caller whose startup blocks — today
 *     the replicator, whose replica restore is unbounded — has to arm the signal
 *     ahead of that work to interrupt it, and arming twice would leave two
 *     listeners disagreeing about which one acts. One arming point, whose signal
 *     is consumed here, is what keeps the request answered exactly once whether it
 *     arrives during startup or after it.
 * @returns a Promise that resolves/rejects when any of the services stops/throws.
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
  const stopServices = (signal: NodeJS.Signals) => {
    const GRACEFUL_SIGNALS = GRACEFUL_SHUTDOWN as readonly NodeJS.Signals[];

    services.forEach(async svc => {
      if (GRACEFUL_SIGNALS.includes(signal) && svc.drain) {
        lc.info?.(`draining ${svc.constructor.name} ${svc.id} (${signal})`);
        await svc.drain();
      }
      lc.info?.(`stopping ${svc.constructor.name} ${svc.id} (${signal})`);
      await svc.stop();
    });
  };

  for (const signal of FORCEFUL_SHUTDOWN) {
    parent.once(signal, () => stopServices(signal));
  }

  // Already requested, during the caller's startup: return without starting
  // anything, which IS the shutdown. Nothing has run, so there is nothing to
  // drain and nothing holding a file — the same argument the callers make when
  // they return early from their own startup.
  //
  // Not `stopServices()` here. Stopping a service that has never run is not a
  // no-op: a service whose `stop()` waits on the promise its `run()` assigns
  // reads `undefined`, resumes immediately, and races the `run()` this function
  // is about to start — the replicator's stop then collides with its own
  // startup on the write worker's single-flight slot and throws. That rejection
  // would be discarded by the `forEach` above, surface as an unhandled
  // rejection, and exit this worker 13, which makes the manager SIGABRT its
  // siblings undrained. A requested shutdown must not be louder than a crash.
  //
  // A caller that goes on to wait for something a running service would have
  // produced has to race that wait against the same signal; returning here means
  // nothing will ever produce it.
  if (shutdown.aborted) {
    lc.info?.('shutdown requested before services started; not starting them');
    return;
  }
  shutdown.addEventListener('abort', () => stopServices(GRACEFUL_SHUTDOWN[0]), {
    once: true,
  });

  try {
    // Run all services and resolve when any of them stops.
    const svc = await Promise.race(
      services.map(svc => svc.run().then(() => svc)),
    );
    lc.info?.(`${svc.constructor.name} (${svc.id}) stopped`);
  } catch (e) {
    lc.error?.(`exiting on error`, e);
    throw e;
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
    lc.error?.(`exiting with error: ${String(e)}`, e);
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
