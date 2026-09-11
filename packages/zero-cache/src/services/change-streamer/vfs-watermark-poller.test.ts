import * as childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {createSilentLogContext} from '../../../../shared/src/logging-test-utils.ts';
import {Database} from '../../../../zqlite/src/db.ts';
import {StatementRunner} from '../../db/statements.ts';
import type {Source} from '../../types/streams.ts';
import {
  initReplicationState,
  updateReplicationWatermark,
} from '../replicator/schema/replication-state.ts';
import type {BackedUpWatermark} from './backup-monitor.ts';
import {
  buildLitestreamVfsReplicaURL,
  VfsWatermarkPoller,
  type VfsPollerConfig,
} from './vfs-watermark-poller.ts';

// Replace node:child_process.spawn so the args it was called with can be
// asserted and the child it returns is stood up in process. Node's built-in
// module exports are non-configurable, so vi.spyOn cannot be used here. See
// litestream/commands.test.ts for the same pattern.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return {
    ...actual,
    spawn: vi.fn(
      (
        _command: string,
        _args: readonly string[],
        options: Pick<childProcess.SpawnOptions, 'stdio'>,
      ) => fakeChild(nextBehaviour, options),
    ),
  };
});
const spawnMock = vi.mocked(childProcess.spawn);

function line(stateVersion: string, writeTimeMs: number, litestreamTime = '') {
  const metadata = litestreamTime
    ? `,"litestream_time":"${litestreamTime}"`
    : '';
  return `{"query_result":[{"stateVersion":"${stateVersion}","writeTimeMs":${writeTimeMs}}],"metadata":{${metadata.replace(/^,/, '')}}}`;
}

/**
 * What the fake `vfs-query` does, declared rather than scripted.
 *
 * A shell script is not an executable on every platform: the spawn fails, the
 * child has no stdout to read, and every assertion about what the poller parsed
 * is left asserting nothing at all. Standing the child up in process keeps the
 * behaviour explicit and runs the same everywhere.
 *
 * `emits` mirrors the real vfs-query, which stays running between emissions —
 * so the child does not close until it is killed.
 */
type FakeVfsQuery =
  | {kind: 'emits'; lines: readonly string[]}
  | {kind: 'exit'; code: number};

/** Emits nothing and stays alive, which is the idle shape. */
const BLOCK: FakeVfsQuery = {kind: 'emits', lines: []};

/** The path the poller is configured with; nothing ever executes it. */
const FAKE_EXECUTABLE = join('fake', 'bin', 'fake-vfs-query');

/**
 * Stands in for a spawned `vfs-query`, implementing what the poller consumes: a
 * readable stdout, `error`/`close`, and `kill`.
 *
 * `pid` and `killed` are what a real spawn handle carries once its process
 * started, and the cases below assert against `killed`.
 */
function fakeChild(
  behaviour: FakeVfsQuery,
  options: Pick<childProcess.SpawnOptions, 'stdio'> = {},
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough | null;
    pid: number;
    killed: boolean;
    kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
  };

  // A stream exists only for a piped slot, so code that reads an inherited one
  // fails here as it would in production.
  const stdio = Array.isArray(options.stdio) ? options.stdio : [];
  child.stdout = stdio[1] === 'pipe' ? new PassThrough() : null;
  child.pid = 4242;
  child.killed = false;

  let closed = false;
  const close = (code: number | null, signal: NodeJS.Signals | null) => {
    if (closed) {
      return;
    }
    closed = true;
    child.stdout?.end();
    child.emit('close', code, signal);
  };
  // The close is deferred: a real process exits asynchronously, so a `close`
  // handler that runs inside the `kill()` call observes state the caller has not
  // finished updating. Emitting it synchronously would collapse the interleaving
  // that a replacement spawned before the old child exits depends on.
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    child.killed = true;
    setImmediate(() => close(null, signal ?? 'SIGTERM'));
    return true;
  });

  setImmediate(() => {
    if (closed) {
      return;
    }
    if (behaviour.kind === 'exit') {
      close(behaviour.code, null);
      return;
    }
    for (const line of behaviour.lines) {
      child.stdout?.write(`${line}\n`);
    }
    // Deliberately no close: the real process stays up between emissions.
  });
  return child as unknown as childProcess.ChildProcess;
}

/** The behaviour the next spawn will stand up, set by each case. */
let nextBehaviour: FakeVfsQuery = BLOCK;

describe('change-streamer/vfs-watermark-poller', () => {
  let dir = '';
  let replicaFile = '';
  let setupDb: Database;
  let source: Source<BackedUpWatermark> | undefined;
  let pushed: BackedUpWatermark[];
  let consumeError: unknown;

  function makePoller(
    behaviour: FakeVfsQuery,
    overrides: Partial<Omit<VfsPollerConfig, 'executable'>> = {},
  ) {
    nextBehaviour = behaviour;
    const poller = new VfsWatermarkPoller(
      createSilentLogContext(),
      replicaFile,
      {
        executable: FAKE_EXECUTABLE,
        remotePollIntervalMs: 50,
        backupURL: 's3://fake-bucket/backup',
        ...overrides,
      },
    );
    source = poller.start();
    pushed = [];
    consumeError = undefined;
    void (async () => {
      try {
        for await (const backedUp of source) {
          pushed.push(backedUp);
        }
      } catch (e) {
        consumeError = e;
      }
    })();
    return poller;
  }

  function setLocalWatermark(stateVersion: string, writeTimeMs = 0) {
    const db = new Database(createSilentLogContext(), replicaFile);
    try {
      updateReplicationWatermark(
        new StatementRunner(db),
        stateVersion,
        writeTimeMs,
      );
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vfs-watermark-poller-test-'));
    replicaFile = join(dir, 'replica.db');
  });

  /** Gives the configured replica path a database at watermark '00'. */
  function setUp() {
    setupDb = new Database(createSilentLogContext(), replicaFile);
    initReplicationState(setupDb, ['zero_pub'], '00');
    setupDb.close();
  }

  afterEach(() => {
    source?.cancel();
    spawnMock.mockClear();
    // The replica lives in this directory, so it goes with the case. Left
    // behind, one collects in the system temp directory per run and nothing
    // else removes them.
    rmSync(dir, {recursive: true, force: true});
  });

  test('spawns the remote poller with the expected args when local diverges from remote', () => {
    setUp();
    // start() runs an immediate checkLocalWatermark(); local ('00') differs
    // from remote (undefined at construction), so this alone spawns.
    makePoller(BLOCK, {
      remotePollIntervalMs: 250,
      logLevel: 'debug',
      logFormat: 'text',
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [executable, args] = spawnMock.mock.calls[0];
    expect(executable).toEqual(expect.stringContaining('fake-vfs-query'));
    expect(args).toEqual([
      '--replica-url',
      's3://fake-bucket/backup',
      '--query',
      `SELECT stateVersion, writeTimeMs FROM "_zero.replicationState"`,
      '--remote-poll-interval',
      '250ms',
      '--log-level',
      'debug',
      '--log-format',
      'text',
    ]);
  });

  test('pushes watermark updates parsed from vfs-query stdout, deduped by stateVersion', async () => {
    setUp();
    const poller = makePoller({
      kind: 'emits',
      lines: [
        line('01', 100, '2025-01-01T00:00:00Z'),
        line('01', 100, '2025-01-01T00:00:01Z'), // duplicate watermark
        line('02', 200, '2025-01-01T00:00:02Z'),
      ],
    });
    poller.checkLocalWatermark();

    await vi.waitFor(() =>
      expect(pushed.map(p => p.watermark)).toEqual(['01', '02']),
    );
    expect(pushed[0].backupTimeMs).toEqual(Date.parse('2025-01-01T00:00:00Z'));
    expect(pushed[0].writeTimeMs).toEqual(100);
  });

  test('missing metadata.litestream_time does not drop the watermark update', async () => {
    setUp();
    // No litestream_time in metadata at all (as vfs-query sends on a
    // metadata-read failure, since the Go field is `omitempty`).
    const poller = makePoller({
      kind: 'emits',
      lines: [
        '{"query_result":[{"stateVersion":"01","writeTimeMs":100}],"metadata":{}}',
      ],
    });
    const before = Date.now();
    poller.checkLocalWatermark();

    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0].watermark).toEqual('01');
    // Falls back to wall-clock time rather than being dropped entirely.
    expect(pushed[0].backupTimeMs).toBeGreaterThanOrEqual(before);
  });

  test('malformed output is logged and ignored, not thrown', async () => {
    setUp();
    const poller = makePoller({
      kind: 'emits',
      lines: [
        'not json',
        '{"query_result":[],"metadata":{}}', // empty tuple: fails schema
        line('01', 100, '2025-01-01T00:00:00Z'),
      ],
    });
    poller.checkLocalWatermark();

    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    expect(pushed[0].watermark).toEqual('01');
    expect(consumeError).toBeUndefined();
  });

  test('stops the remote poller once the local watermark catches up', async () => {
    setUp();
    const poller = makePoller({
      kind: 'emits',
      lines: [line('01', 100, '2025-01-01T00:00:00Z')],
    });
    poller.checkLocalWatermark();
    await vi.waitFor(() => expect(pushed).toHaveLength(1));

    const child = spawnMock.mock.results[0].value as childProcess.ChildProcess;
    expect(child.killed).toBe(false);

    setLocalWatermark('01');
    poller.checkLocalWatermark();

    await vi.waitFor(() => expect(child.killed).toBe(true));
    // No respawn once caught up.
    await new Promise(r => setTimeout(r, 100));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('a replacement spawned before the old child exits is not orphaned', async () => {
    setUp();
    const poller = makePoller({
      kind: 'emits',
      lines: [line('01', 100, '2025-01-01T00:00:00Z')],
    });
    poller.checkLocalWatermark();
    await vi.waitFor(() => expect(pushed).toHaveLength(1));
    const child1 = spawnMock.mock.results[0].value as childProcess.ChildProcess;
    const child1Closed = new Promise<void>(resolve =>
      child1.once('close', () => resolve()),
    );

    // Catch up (which stops the poller) and fall behind again (which restarts
    // it) before the first child has had a chance to exit.
    setLocalWatermark('01');
    poller.checkLocalWatermark();
    expect(child1.killed).toBe(true);
    setLocalWatermark('02');
    poller.checkLocalWatermark();
    expect(spawnMock).toHaveBeenCalledTimes(2);
    const child2 = spawnMock.mock.results[1].value as childProcess.ChildProcess;

    // The stale child's exit must not schedule a respawn next to the
    // replacement (the initial backoff is 2s).
    await child1Closed;
    await new Promise(resolve => setTimeout(resolve, 2_500));
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // ...and the replacement is still tracked: catching up stops it.
    setLocalWatermark('01');
    poller.checkLocalWatermark();
    expect(child2.killed).toBe(true);
  });

  test('an unexpected exit while still behind schedules a respawn', async () => {
    setUp();
    const poller = makePoller(
      {kind: 'exit', code: 1},
      {
        remotePollIntervalMs: 10,
      },
    );
    poller.checkLocalWatermark();

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    // Backoff respawns the poller even though the local watermark never
    // changed (still behind), because it crashed rather than caught up.
    await vi.waitFor(
      () => expect(spawnMock.mock.calls.length).toBeGreaterThan(1),
      {
        timeout: 5_000,
      },
    );
  });
});

describe('buildLitestreamVfsReplicaURL', () => {
  test('returns the URL unchanged when no endpoint/region are given', () => {
    expect(
      buildLitestreamVfsReplicaURL({backupURL: 's3://bucket/path'}),
    ).toEqual('s3://bucket/path');
  });

  test('leaves non-s3 URLs untouched even with endpoint/region set', () => {
    expect(
      buildLitestreamVfsReplicaURL({
        backupURL: 'file:///tmp/backup',
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
      }),
    ).toEqual('file:///tmp/backup');
  });

  test('adds endpoint and region query params to an s3 URL', () => {
    const url = buildLitestreamVfsReplicaURL({
      backupURL: 's3://bucket/path',
      endpoint: 'http://localhost:9000',
      region: 'us-east-1',
    });
    expect(new URL(url).searchParams.get('endpoint')).toEqual(
      'http://localhost:9000',
    );
    expect(new URL(url).searchParams.get('region')).toEqual('us-east-1');
  });

  test('does not override endpoint/region params already present', () => {
    const url = buildLitestreamVfsReplicaURL({
      backupURL: 's3://bucket/path?endpoint=http://existing:9000',
      endpoint: 'http://localhost:9000',
    });
    expect(new URL(url).searchParams.get('endpoint')).toEqual(
      'http://existing:9000',
    );
  });
});
