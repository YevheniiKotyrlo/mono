import EventEmitter from 'node:events';
import {LogContext} from '@rocicorp/logger';
import {resolver} from '@rocicorp/resolver';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {promiseVoid} from '../../../shared/src/resolved-promises.ts';
import type * as Metrics from '../observability/metrics.ts';

const startupRecordMs = vi.hoisted(() => vi.fn());
const workerStartupRecordMs = vi.hoisted(() => vi.fn());
const logLastChanceSQLiteCorruptionDiagnostics = vi.hoisted(() => vi.fn());

vi.mock('../db/sqlite-corruption.ts', () => ({
  logLastChanceSQLiteCorruptionDiagnostics,
}));

vi.mock('../observability/metrics.ts', async importOriginal => {
  const actual = await importOriginal<typeof Metrics>();
  return {
    ...actual,
    getOrCreateHistogram: vi.fn((_category, name) => ({
      recordMs:
        name === 'startup_duration' ? startupRecordMs : workerStartupRecordMs,
    })),
  };
});

import {
  exitAfter,
  INTENTIONAL_SHUTDOWN_ERROR_CODE,
  ProcessManager,
  SHUTDOWN_MESSAGE,
  recordStartupDurationMs,
  runUntilKilled,
  shutdownRequested,
  type WorkerType,
} from '../services/life-cycle.ts';
import type {SingletonService} from '../services/service.ts';
import {ConfigurationError} from '../types/configuration-error.ts';
import {inProcChannel} from '../types/processes.ts';

describe('shutdown', () => {
  const lc = createSilentLogContext();
  let proc: EventEmitter;
  let processes: ProcessManager;
  let events: string[];
  let changeStreamer: TestWorker;
  let replicator: TestWorker;
  let syncer1: TestWorker;
  let syncer2: TestWorker;
  let all: TestWorker[];

  class TestWorker implements SingletonService {
    readonly id: string;
    readonly type: WorkerType;
    draining = resolver();
    finishDrain = resolver();
    running = resolver();
    stopped = resolver();

    constructor(id: string, type: WorkerType) {
      this.id = id;
      this.type = type;
    }

    run() {
      this.running.resolve();
      return this.stopped.promise;
    }

    drain(): Promise<void> {
      events.push(`drain ${this.type}`);
      this.draining.resolve();
      return this.finishDrain.promise;
    }

    stop() {
      events.push(`stop ${this.type}`);
      this.stopped.resolve();
      return promiseVoid;
    }
  }

  function startWorker(id: string, type: WorkerType): TestWorker {
    const worker = new TestWorker(id, type);
    const [parentPort, childPort] = inProcChannel();

    processes.addWorker(parentPort, type, id);

    // Armed exactly where a real worker arms it — before anything that could
    // block — so this harness exercises the same single-arming-point arrangement
    // production uses rather than a shape only the test has.
    void runUntilKilled(
      lc,
      childPort,
      shutdownRequested(childPort),
      worker,
    ).then(
      () => parentPort.emit('close', 0),
      () => parentPort.emit('close', -1),
    );
    return worker;
  }

  beforeEach(async () => {
    startupRecordMs.mockReset();
    workerStartupRecordMs.mockReset();

    // For testing process.exit()
    process.env['SINGLE_PROCESS'] = '1';

    proc = new EventEmitter();
    processes = new ProcessManager(lc, proc);
    events = [];
    changeStreamer = startWorker('cs', 'supporting');
    replicator = startWorker('rep', 'supporting');
    syncer1 = startWorker('s1', 'user-facing');
    syncer2 = startWorker('s2', 'user-facing');

    all = [changeStreamer, replicator, syncer1, syncer2];

    await Promise.all(all.map(w => w.running.promise));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each([
    ['SIGTERM', 0],
    ['SIGINT', 0],
    ['SIGQUIT', INTENTIONAL_SHUTDOWN_ERROR_CODE],
    ['SIGABRT', -1],
  ])(
    'shutdown before workers started: %s',
    async (signal, expectedExitCode) => {
      const {promise: exitCode, resolve} = resolver<number>();
      proc = new EventEmitter();
      proc.on('exit', resolve);

      new ProcessManager(lc, proc);
      proc.emit(signal);
      expect(await exitCode).toBe(expectedExitCode);
    },
  );

  test.each([['SIGTERM'], ['SIGINT']])(
    'graceful shutdown: %s',
    async signal => {
      proc.emit(signal);

      await syncer1.draining.promise;
      await syncer2.draining.promise;

      syncer1.finishDrain.resolve();
      syncer2.finishDrain.resolve();

      await changeStreamer.draining.promise;
      await replicator.draining.promise;

      changeStreamer.finishDrain.resolve();
      replicator.finishDrain.resolve();

      await Promise.all(all.map(w => w.stopped.promise));

      expect(events).toEqual([
        'drain user-facing',
        'drain user-facing',
        'stop user-facing',
        'stop user-facing',
        'drain supporting',
        'drain supporting',
        'stop supporting',
        'stop supporting',
      ]);
    },
  );

  test('a drained shutdown does not exit before its supporting workers stop', async () => {
    // The replicator is a supporting worker and it holds the replica file open.
    // Exiting while it runs lets a caller that sees this process close still race
    // it — invisible on POSIX, where unlink-while-open is legal, and a failure on
    // Windows, which refuses to unlink a file somebody has open.
    const exited = resolver<number>();
    proc.on('exit', code => exited.resolve(code));

    proc.emit('message', [...SHUTDOWN_MESSAGE]);

    await syncer1.draining.promise;
    await syncer2.draining.promise;
    syncer1.finishDrain.resolve();
    syncer2.finishDrain.resolve();

    await changeStreamer.draining.promise;
    await replicator.draining.promise;
    expect(
      await Promise.race([
        exited.promise.then(() => 'exited'),
        new Promise(resolve => setTimeout(resolve, 250, 'still running')),
      ]),
    ).toBe('still running');

    changeStreamer.finishDrain.resolve();
    replicator.finishDrain.resolve();

    expect(await exited.promise).toBe(0);
    // Stopped, not merely asked.
    expect(events.filter(e => e === 'stop supporting')).toHaveLength(2);
  });

  test('a supporting worker that never stops does not hold the process forever', async () => {
    // A wait without a bound is worse than giving up: a container runtime would
    // kill the process mid-shutdown for exceeding its grace period.
    vi.useFakeTimers();
    try {
      const exited = resolver<number>();
      proc.on('exit', code => exited.resolve(code));

      proc.emit('message', [...SHUTDOWN_MESSAGE]);

      await syncer1.draining.promise;
      await syncer2.draining.promise;
      syncer1.finishDrain.resolve();
      syncer2.finishDrain.resolve();

      await changeStreamer.draining.promise;
      await replicator.draining.promise;
      // Neither supporting worker ever finishes draining.

      await vi.advanceTimersByTimeAsync(10_000);
      expect(await exited.promise).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('how it exits is decided when it is built, not when it exits', async () => {
    // Because the exit can now happen a tick after the drain rather than inside
    // it, and anything may have changed the environment by then. Re-reading the
    // mode at exit turned an in-process exit into `process.exit()` — which, in a
    // test runner, kills the worker running the suite.
    const exited = resolver<number>();
    const built = new EventEmitter();
    built.on('exit', code => exited.resolve(code));
    new ProcessManager(lc, built);

    delete process.env['SINGLE_PROCESS'];
    built.emit('message', [...SHUTDOWN_MESSAGE]);

    // Reaches the emitter it was built with rather than the real process.
    expect(await exited.promise).toBe(0);
  });

  test('a shutdown request over IPC drains exactly like SIGTERM', async () => {
    // The only way to ask on Windows, where Node delivers no SIGTERM and a
    // `kill()` terminates the process outright — running none of this and leaving
    // these workers behind. The drain must be identical, so this asserts the same
    // sequence the signal cases above do.
    proc.emit('message', [...SHUTDOWN_MESSAGE]);

    await syncer1.draining.promise;
    await syncer2.draining.promise;
    syncer1.finishDrain.resolve();
    syncer2.finishDrain.resolve();

    await changeStreamer.draining.promise;
    await replicator.draining.promise;
    changeStreamer.finishDrain.resolve();
    replicator.finishDrain.resolve();

    await Promise.all(all.map(w => w.stopped.promise));

    expect(events).toEqual([
      'drain user-facing',
      'drain user-facing',
      'stop user-facing',
      'stop user-facing',
      'drain supporting',
      'drain supporting',
      'stop supporting',
      'stop supporting',
    ]);
  });

  test('a shutdown request before any worker starts exits cleanly', async () => {
    const {promise: exitCode, resolve} = resolver<number>();
    proc = new EventEmitter();
    proc.on('exit', resolve);

    new ProcessManager(lc, proc);
    proc.emit('message', [...SHUTDOWN_MESSAGE]);
    expect(await exitCode).toBe(0);
  });

  test.each([
    ['a different message type', ['ready', {ready: true}]],
    ['a bare string', 'shutdown'],
    ['the type without a payload', ['shutdown']],
    ['null', null],
  ])('%s does not drain', async (_name, message) => {
    // The channel carries other traffic, so recognising a shutdown too loosely
    // would turn an ordinary message into an outage.
    proc.emit('message', message);
    await Promise.resolve();

    expect(events).toEqual([]);

    // And the drain has not merely emitted nothing — it has not been entered.
    // Racing against an already-resolved sentinel is how to observe that a
    // promise is still pending; `Promise.race` settles on the first of the two,
    // so the sentinel wins only while the drain has not.
    const pending = Symbol('pending');
    expect(
      await Promise.race([syncer1.draining.promise, Promise.resolve(pending)]),
    ).toBe(pending);
  });

  test.each([['SIGTERM'], ['SIGINT']])(
    'error during graceful shutdown: %s',
    async signal => {
      proc.emit(signal);

      await syncer1.draining.promise;
      await syncer2.draining.promise;

      syncer1.stopped.reject('doh');
      syncer2.finishDrain.resolve();

      await changeStreamer.draining.promise;
      await replicator.draining.promise;

      changeStreamer.finishDrain.resolve();
      replicator.finishDrain.resolve();

      await Promise.allSettled(all.map(w => w.stopped.promise));

      expect(events).toEqual([
        'drain user-facing',
        'drain user-facing',
        'stop user-facing',
        'drain supporting',
        'drain supporting',
        'stop supporting',
        'stop supporting',
      ]);
    },
  );

  test.each([['SIGTERM'], ['SIGINT']])(
    'all error during graceful shutdown: %s',
    async signal => {
      proc.emit(signal);

      await syncer1.draining.promise;
      await syncer2.draining.promise;

      syncer1.stopped.reject('doh');
      syncer2.stopped.reject('doh');

      await changeStreamer.draining.promise;
      await replicator.draining.promise;

      changeStreamer.finishDrain.resolve();
      replicator.finishDrain.resolve();

      await Promise.allSettled(all.map(w => w.stopped.promise));

      expect(events).toEqual([
        'drain user-facing',
        'drain user-facing',
        'drain supporting',
        'drain supporting',
        'stop supporting',
        'stop supporting',
      ]);
    },
  );

  test.each([
    [
      'SIGQUIT',
      () => proc.emit('SIGQUIT'),
      [
        'stop supporting',
        'stop supporting',
        'stop user-facing',
        'stop user-facing',
      ],
    ],
    [
      'SIGABRT',
      () => proc.emit('SIGABRT'),
      [
        'stop supporting',
        'stop supporting',
        'stop user-facing',
        'stop user-facing',
      ],
    ],
    [
      'supporting worker exits',
      () => replicator.stop(),
      [
        'stop supporting',
        'stop supporting',
        'stop user-facing',
        'stop user-facing',
      ],
    ],
    [
      'supporting worker error',
      () => changeStreamer.stopped.reject('foo'),
      ['stop supporting', 'stop user-facing', 'stop user-facing'],
    ],
    [
      'user-facing worker exits',
      () => syncer1.stop(),
      [
        'stop supporting',
        'stop supporting',
        'stop user-facing',
        'stop user-facing',
      ],
    ],
    [
      'user-facing worker error',
      () => syncer2.stopped.reject('foo'),
      ['stop supporting', 'stop supporting', 'stop user-facing'],
    ],
  ])('forceful shutdown: %s', async (_name, fn, expectedEvents) => {
    fn();

    await Promise.allSettled(all.map(w => w.stopped.promise));

    // sort() because order doesn't matter.
    expect(events.sort()).toEqual(expectedEvents.sort());
  });

  test('records worker startup duration when a worker is ready', () => {
    const [parentPort, childPort] = inProcChannel();
    processes.addWorker(parentPort, 'supporting', 'replicator.ts (backup)');

    childPort.send(['ready', {ready: true}]);

    expect(workerStartupRecordMs).toHaveBeenCalledWith(expect.any(Number), {
      worker: 'backup_replicator',
      type: 'supporting',
    });
  });

  test('does not record zero-cache as a worker startup duration', () => {
    const [parentPort, childPort] = inProcChannel();
    processes.addWorker(parentPort, 'user-facing', 'zero-cache');

    childPort.send(['ready', {ready: true}]);

    expect(startupRecordMs).not.toHaveBeenCalled();
    expect(workerStartupRecordMs).not.toHaveBeenCalled();
  });

  test('records top-level startup duration explicitly', () => {
    recordStartupDurationMs(123);

    expect(startupRecordMs).toHaveBeenCalledWith(123, {
      component: 'dispatcher',
    });
  });
});

describe('exitAfter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    logLastChanceSQLiteCorruptionDiagnostics.mockReset();
  });

  test('exits 0 for configuration errors', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
      throw Object.assign(new Error('process.exit'), {code});
    });

    await expect(
      exitAfter(createSilentLogContext(), () => {
        throw new ConfigurationError('bad config');
      }),
    ).rejects.toMatchObject({code: 0});

    expect(exit).toHaveBeenCalledWith(0);
  });

  test('logs corruption diagnostics and flushes before a fatal exit', async () => {
    const initialLC = createSilentLogContext();
    const flushDone = resolver();
    const flush = vi.fn(() => flushDone.promise);
    const activeLC = new LogContext('debug', undefined, {
      flush,
      log: vi.fn(),
    });
    const error = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT',
    });
    let lc = initialLC;
    const exit = vi.spyOn(process, 'exit').mockImplementation(code => {
      throw Object.assign(new Error('process.exit'), {code});
    });

    const exiting = exitAfter(
      () => lc,
      () => {
        lc = activeLC;
        return Promise.reject(error);
      },
    );

    await Promise.resolve();

    expect(logLastChanceSQLiteCorruptionDiagnostics).toHaveBeenCalledWith(
      activeLC,
      error,
    );
    expect(flush).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    flushDone.resolve();
    await expect(exiting).rejects.toMatchObject({code: -1});
    expect(exit).toHaveBeenCalledWith(-1);
  });
});

describe('shutdownRequested', () => {
  // These cover the window `runUntilKilled` cannot: it takes services, so it can
  // only be called once they exist, and a worker whose startup blocks has not got
  // there yet. Every other shutdown test in this file installs its listener before
  // anything blocks, which is exactly why none of them would notice this gap.

  test('aborts on a request arriving before any service exists', () => {
    const parent = new EventEmitter();
    const signal = shutdownRequested(parent);
    expect(signal.aborted).toBe(false);

    parent.emit('message', [...SHUTDOWN_MESSAGE]);
    expect(signal.aborted).toBe(true);
  });

  test('aborts on a signal too, since that is the operator-facing contract', () => {
    const parent = new EventEmitter();
    const signal = shutdownRequested(parent);

    parent.emit('SIGTERM');
    expect(signal.aborted).toBe(true);
  });

  test('ignores messages that are not shutdown requests', () => {
    const parent = new EventEmitter();
    const signal = shutdownRequested(parent);

    parent.emit('message', ['ready', {ready: true}]);
    parent.emit('message', ['shutdown']); // wrong arity
    parent.emit('message', 'shutdown'); // not an array
    expect(signal.aborted).toBe(false);
  });

  test('unblocks work waiting on it, rather than only recording the request', async () => {
    // The failure this pins is not "the request was missed" — Node holds an IPC
    // message until a listener appears, so it does arrive. It is that nothing
    // waiting had any reason to stop waiting, so the worker ran on holding its
    // files while the manager gave up on it.
    const parent = new EventEmitter();
    const signal = shutdownRequested(parent);

    const {promise: blocked, resolve} = resolver<'aborted' | 'finished'>();
    signal.addEventListener('abort', () => resolve('aborted'), {once: true});

    parent.emit('message', [...SHUTDOWN_MESSAGE]);
    expect(await blocked).toBe('aborted');
  });

  test('a request arriving during startup still stops the services', async () => {
    // The window between arming and having services to stop. It is the one the
    // first version of this reopened: arming early consumes the queued IPC message,
    // Node delivers it to that listener and to no other, so a listener installed
    // alongside the services would never see it and the request would be recorded
    // and then dropped. Which is why the signal is passed in rather than installed
    // there — this asserts the request survives the gap.
    const parent = new EventEmitter();
    const shutdown = shutdownRequested(parent);

    parent.emit('message', [...SHUTDOWN_MESSAGE]); // mid-startup
    expect(shutdown.aborted).toBe(true);

    const stopped = resolver<void>();
    const service = {
      id: 'startup-window',
      run: () => promiseVoid,
      stop: () => {
        stopped.resolve();
        return promiseVoid;
      },
    };
    void runUntilKilled(createSilentLogContext(), parent, shutdown, service);

    // Resolves only if the already-aborted signal is acted on; a version that
    // ignored it would leave this pending and fail on the suite's own budget.
    await stopped.promise;
  });
});
