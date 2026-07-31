import * as childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {LogContext} from '@rocicorp/logger';
import {afterEach, describe, expect, test, vi} from 'vitest';
import {unreachable} from '../../../../shared/src/asserts.ts';
import {
  createSilentLogContext,
  TestLogSink,
} from '../../../../shared/src/logging-test-utils.ts';
import {must} from '../../../../shared/src/must.ts';
import {Database} from '../../../../zqlite/src/db.ts';
import {type NormalizedZeroConfig} from '../../config/normalize.ts';
import {changeLogFileName} from '../replicator/change-log-db.ts';
import {initReplicationState} from '../replicator/schema/replication-state.ts';
import {
  getLastBackupTime,
  parseBackupCreatedTimes,
  tryRestore,
} from './commands.ts';
import * as litestreamMetrics from './metrics.ts';

// Wrap (don't replace) node:child_process.spawn so tests can assert the args it
// was called with. Node's built-in module exports are non-configurable, so
// vi.spyOn cannot be used here.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return {...actual, spawn: vi.fn(actual.spawn)};
});

/**
 * What the fake `litestream` does, by subcommand.
 *
 * Declared rather than scripted: the child is faked, not the executable. What
 * these suites cover is the output parsing, the exit-code handling and the
 * timeout-and-kill path, none of which needs a real process — and a scripted
 * fake would need one that the host can execute, which a `#!/bin/sh` file is
 * not everywhere.
 */
type FakeLitestream =
  | {kind: 'listing'; snapshots: readonly string[]; wal: readonly string[]}
  | {kind: 'exit'; code: number}
  | {kind: 'hang'}
  | {kind: 'restore'; copyFrom?: string};

/**
 * Stands in for a spawned `litestream`, implementing only what the production
 * code consumes: encoded stdout/stderr, `error`/`close`, and `kill`.
 */
function fakeChild(
  behaviour: FakeLitestream,
  args: readonly string[],
  options: {stdio?: unknown} = {},
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough | null;
    stderr: PassThrough | null;
    kill: ReturnType<typeof vi.fn>;
  };

  // Only piped slots get a stream, exactly as a real child does. That keeps the
  // implicit guard the real fixture used to provide: reverting the production
  // spawn to `stdio: 'inherit'` leaves stdout/stderr null and the code that
  // reads them fails, rather than quietly losing INC-961's protection.
  const stdio = Array.isArray(options.stdio) ? options.stdio : [];
  child.stdout = stdio[1] === 'pipe' ? new PassThrough() : null;
  child.stderr = stdio[2] === 'pipe' ? new PassThrough() : null;

  let done = false;
  const close = (code: number | null, signal: NodeJS.Signals | null) => {
    if (done) {
      return;
    }
    done = true;
    child.stdout?.end();
    child.stderr?.end();
    child.emit('close', code, signal);
  };
  // A vi.fn so the timeout test can assert the process was actually killed —
  // the production code rejects before killing, so nothing else observes it.
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    close(null, signal ?? 'SIGKILL');
    return true;
  });

  const subcommand = args[0];
  setImmediate(() => {
    // A late fire after teardown must not throw out of the immediate: an
    // uncaught exception there is attributed to the file, not the test, and
    // fails every case in it.
    if (done) {
      return;
    }
    switch (behaviour.kind) {
      case 'listing': {
        const rows =
          subcommand === 'snapshots' ? behaviour.snapshots : behaviour.wal;
        child.stdout?.write(`${rows.join('\n')}\n`);
        close(0, null);
        break;
      }
      case 'exit':
        close(behaviour.code, null);
        break;
      case 'restore':
        if (subcommand === 'restore') {
          if (behaviour.copyFrom !== undefined) {
            // The restore target is the trailing argument — the only one that is
            // neither a flag nor a flag's value — so this survives another flag
            // being added ahead of it, which an index would not.
            copyFileSync(behaviour.copyFrom, must(args.at(-1)));
          }
          close(0, null);
        } else {
          close(1, null);
        }
        break;
      case 'hang':
        // Never closes on its own: the production timeout must kill it.
        break;
      default:
        // A new variant with no arm here would emit no `close`, which is
        // byte-for-byte how `hang` behaves — so the test would time out and read
        // as deliberate. This makes it a compile error instead.
        unreachable(behaviour);
    }
  });
  return child as unknown as childProcess.ChildProcess;
}

/**
 * Points the config at a `litestream` path that is never executed, and makes
 * `spawn` return a fake child driven by `behaviour`.
 */
function configWithFakeLitestream(
  behaviour: FakeLitestream,
  replicaFile?: string,
): NormalizedZeroConfig {
  // Paths only — nothing here is created or executed. The child is faked, so the
  // executable is never resolved and a replica file is never opened; a real temp
  // directory would just be created and left behind on every call.
  const dir = join(tmpdir(), 'litestream-test-fake');
  const executable = join(dir, 'fake-litestream');
  vi.mocked(childProcess.spawn).mockReset();
  vi.mocked(childProcess.spawn).mockImplementation(((
    _command: string,
    args: readonly string[],
    options: {stdio?: unknown},
  ) =>
    fakeChild(
      behaviour,
      args,
      options,
    )) as unknown as typeof childProcess.spawn);
  return {
    port: 4848,
    log: {format: 'text'},
    replica: {file: replicaFile ?? join(dir, 'replica.db')},
    litestream: {
      port: 4850,
      executable,
      backupURL: 's3://fake-bucket/backup',
      configPath: './src/services/litestream/config.yml',
      logLevel: 'warn',
      restoreUsingV5: false,
      checkpointThresholdMB: 40,
      incrementalBackupIntervalMinutes: 15,
      snapshotBackupIntervalHours: 12,
      multipartConcurrency: 48,
      multipartSize: 16 * 1024 * 1024,
      restoreParallelism: 48,
    },
  } as unknown as NormalizedZeroConfig;
}

function createRestorableReplica(file: string, watermark: string) {
  const db = new Database(createSilentLogContext(), file);
  try {
    initReplicationState(db, ['zero_pub'], watermark);
  } finally {
    db.close();
  }
}

describe('litestream/commands parseBackupCreatedTimes', () => {
  const lc = createSilentLogContext();

  test('parses the created column from snapshot output', () => {
    const output =
      `replica  generation        index  size     created\n` +
      `s3       1862f44967b3863f  0      4546445  2026-06-10T01:11:32Z\n`;
    expect(parseBackupCreatedTimes(lc, 'snapshots', output)).toEqual([
      new Date('2026-06-10T01:11:32Z'),
    ]);
  });

  test('parses the created column (last) from wal output with extra columns', () => {
    const output =
      `replica  generation        index  offset  size  created\n` +
      `s3       1862f44967b3863f  0      0       100   2026-06-10T01:11:32Z\n` +
      `s3       1862f44967b3863f  1      4096    200   2026-06-10T01:12:00Z\n`;
    expect(parseBackupCreatedTimes(lc, 'wal', output)).toEqual([
      new Date('2026-06-10T01:11:32Z'),
      new Date('2026-06-10T01:12:00Z'),
    ]);
  });

  test('skips the header, blank lines, and short lines', () => {
    const output =
      `\n` +
      `replica  generation        index  size     created\n` +
      `\n` +
      `   \n` +
      `s3       1862f44967b3863f  0      4546445  2026-06-10T01:11:32Z\n`;
    expect(parseBackupCreatedTimes(lc, 'snapshots', output)).toEqual([
      new Date('2026-06-10T01:11:32Z'),
    ]);
  });

  test('returns empty for empty or header-only output', () => {
    expect(parseBackupCreatedTimes(lc, 'snapshots', '')).toEqual([]);
    expect(
      parseBackupCreatedTimes(
        lc,
        'snapshots',
        `replica  generation  index  size  created\n`,
      ),
    ).toEqual([]);
  });

  test('warns and skips lines with an unparseable created time', () => {
    const sink = new TestLogSink();
    const lc = new LogContext('debug', undefined, sink);
    const output =
      `replica  generation        index  size     created\n` +
      `s3       1862f44967b3863f  0      4546445  not-a-date\n` +
      `s3       1862f44967b3863f  1      4546445  2026-06-10T01:12:00Z\n`;
    expect(parseBackupCreatedTimes(lc, 'snapshots', output)).toEqual([
      new Date('2026-06-10T01:12:00Z'),
    ]);
    expect(
      sink.messages.some(
        ([level, , args]) =>
          level === 'warn' &&
          String(args[0]).includes('unexpected line in litestream snapshots'),
      ),
    ).toBe(true);
  });
});

describe('litestream/commands getLastBackupTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const lc = createSilentLogContext();

  test('returns the most recent created time across snapshots and wal', async () => {
    const {litestream, replica} = configWithFakeLitestream({
      kind: 'listing',
      snapshots: [
        'replica generation index size created',
        's3 gen 0 100 2025-04-24T00:00:00Z',
      ],
      wal: [
        'replica generation index offset size created',
        's3 gen 1 0 100 2025-04-24T00:05:00Z',
        's3 gen 2 0 100 2025-04-24T00:10:00Z',
      ],
    });
    expect(await getLastBackupTime(lc, litestream, replica.file)).toEqual(
      new Date('2025-04-24T00:10:00Z'),
    );
  });

  test('rejects when nothing is listed at the destination', async () => {
    const {litestream, replica} = configWithFakeLitestream({
      kind: 'exit',
      code: 0,
    });
    await expect(
      getLastBackupTime(lc, litestream, replica.file),
    ).rejects.toThrow(/no snapshots or WAL segments listed/);
  });

  test('rejects when the litestream process exits non-zero', async () => {
    const {litestream, replica} = configWithFakeLitestream({
      kind: 'exit',
      code: 1,
    });
    await expect(
      getLastBackupTime(lc, litestream, replica.file),
    ).rejects.toThrow(/litestream (snapshots|wal) exited with code 1/);
  });

  test('rejects (and kills the process) when listing times out', async () => {
    vi.useFakeTimers();
    const {litestream, replica} = configWithFakeLitestream({kind: 'hang'});
    const result = getLastBackupTime(lc, litestream, replica.file);
    // Surface the rejection synchronously so the unhandled-rejection guard
    // does not fire before we await it below.
    const settled = result.then(
      v => ({ok: true as const, v}),
      e => ({ok: false as const, e}),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect(String(outcome.ok === false && outcome.e)).toMatch(
      /timed out listing backup state/,
    );

    // The rejection alone does not prove the process was killed: the production
    // code rejects first and kills after, so deleting the kill would leave the
    // assertion above green and leak a process per timeout.
    // Every child, not just the last: the listing runs two subcommands
    // concurrently and both hang, so both have to be killed. Asserting one left
    // the other's leak invisible, and which one `at(-1)` returned depended on the
    // order `Promise.all` happened to evaluate its arguments in.
    const {results} = vi.mocked(childProcess.spawn).mock;
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      // Checked rather than cast: a spawn that threw carries the error here, and
      // reading `.kill` off it would fail as "not a spy" rather than saying so.
      expect(result.type).toBe('return');
      const child = result.value as {kill: ReturnType<typeof vi.fn>};
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    }
  });
});

describe('litestream/commands restoreReplica', () => {
  const lc = createSilentLogContext();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('restores and validates a compatible replica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'litestream-restore-test-'));
    const source = join(dir, 'source.db');
    const replica = join(dir, 'replica.db');
    createRestorableReplica(source, '01');
    const restoredDbBytesAdd = vi.fn();
    vi.spyOn(litestreamMetrics, 'litestreamRestoredDbBytes').mockReturnValue({
      add: restoredDbBytesAdd,
    } as unknown as ReturnType<
      typeof litestreamMetrics.litestreamRestoredDbBytes
    >);
    const {litestream} = configWithFakeLitestream({
      kind: 'restore',
      copyFrom: source,
    });

    await tryRestore(
      lc,
      litestream,
      replica,
      {
        replicaVersion: '01',
        minWatermark: '01',
      },
      'replication_manager',
    );

    expect(existsSync(replica)).toBe(true);
    expect(restoredDbBytesAdd).toHaveBeenCalledWith(
      statSync(replica).size,
      expect.objectContaining({result: 'success'}),
    );
  });

  test('deletes a change log left beside a restored replica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'litestream-restore-test-'));
    const source = join(dir, 'source.db');
    const replica = join(dir, 'replica.db');
    createRestorableReplica(source, '01');
    // A change log whose replica is gone: the file it was anchored to is not
    // the one this restore materializes.
    const staleLog = changeLogFileName(replica);
    writeFileSync(staleLog, '');
    writeFileSync(`${staleLog}-wal2`, '');
    const {litestream} = configWithFakeLitestream({
      kind: 'restore',
      copyFrom: source,
    });

    expect(
      await tryRestore(
        lc,
        litestream,
        replica,
        {replicaVersion: '01', minWatermark: '01'},
        'replication_manager',
      ),
    ).toMatchObject({restored: true, result: 'success'});

    expect(existsSync(replica)).toBe(true);
    expect(existsSync(staleLog)).toBe(false);
    expect(existsSync(`${staleLog}-wal2`)).toBe(false);
  });

  // The process-restart path: `-if-db-not-exists` makes the restore a no-op,
  // and the change log beside the reused replica is still the one written
  // against it. Deleting it would cost every reconnecting subscriber a
  // `too-old` on every deploy.
  test('keeps the change log when the restore reuses an existing replica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'litestream-restore-test-'));
    const replica = join(dir, 'replica.db');
    createRestorableReplica(replica, '01');
    const log = changeLogFileName(replica);
    writeFileSync(log, '');
    const {litestream} = configWithFakeLitestream({kind: 'restore'});

    await tryRestore(
      lc,
      litestream,
      replica,
      {replicaVersion: '01', minWatermark: '01'},
      'replication_manager',
    );

    expect(existsSync(log)).toBe(true);
  });

  test('does not record restored bytes when reusing an existing replica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'litestream-restore-test-'));
    const replica = join(dir, 'replica.db');
    createRestorableReplica(replica, '01');
    const restoredDbBytesAdd = vi.fn();
    vi.spyOn(litestreamMetrics, 'litestreamRestoredDbBytes').mockReturnValue({
      add: restoredDbBytesAdd,
    } as unknown as ReturnType<
      typeof litestreamMetrics.litestreamRestoredDbBytes
    >);
    const {litestream} = configWithFakeLitestream({kind: 'restore'});

    await tryRestore(
      lc,
      litestream,
      replica,
      {
        replicaVersion: '01',
        minWatermark: '01',
      },
      'replication_manager',
    );

    expect(restoredDbBytesAdd).not.toHaveBeenCalled();
  });

  test('deletes an incompatible restored replica', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'litestream-restore-test-'));
    const source = join(dir, 'source.db');
    const replica = join(dir, 'replica.db');
    createRestorableReplica(source, '01');
    const restoreValidationRecordMs = vi.fn();
    vi.spyOn(
      litestreamMetrics,
      'litestreamRestoreValidationDuration',
    ).mockReturnValue({
      recordMs: restoreValidationRecordMs,
    } as unknown as ReturnType<
      typeof litestreamMetrics.litestreamRestoreValidationDuration
    >);
    const {litestream} = configWithFakeLitestream({
      kind: 'restore',
      copyFrom: source,
    });
    writeFileSync(changeLogFileName(replica), '');

    expect(
      await tryRestore(
        lc,
        litestream,
        replica,
        {
          replicaVersion: '02',
          minWatermark: '02',
        },
        'replication_manager',
      ),
    ).toMatchObject({
      restored: false,
      result: 'invalid_replica',
    });

    expect(existsSync(replica)).toBe(false);
    // The change log went with it; the next attempt reseeds against whatever
    // replica it restores.
    expect(existsSync(changeLogFileName(replica))).toBe(false);
    expect(restoreValidationRecordMs).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({result: 'invalid_replica'}),
    );
  });

  // INC-961: the mechanism that actually prevents the paging is spawning
  // `litestream restore` with piped (captured) stdio rather than inheriting the
  // pod's streams — with `stdio: 'inherit'` litestream's own ERROR would reach
  // the pod's stdout directly, before our retry logic could downgrade it.
  // Assert the spawn options so a regression back to inheriting is caught.
  test('spawns `litestream restore` with piped stdio (not inherited)', async () => {
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockClear();
    const dir = mkdtempSync(join(tmpdir(), 'litestream-restore-test-'));
    const source = join(dir, 'source.db');
    const replica = join(dir, 'replica.db');
    createRestorableReplica(source, '01');
    const {litestream} = configWithFakeLitestream({
      kind: 'restore',
      copyFrom: source,
    });

    await tryRestore(
      lc,
      litestream,
      replica,
      {
        replicaVersion: '01',
        minWatermark: '01',
      },
      'replication_manager',
    );

    const restoreCall = spawnMock.mock.calls.find(
      call => Array.isArray(call[1]) && call[1][0] === 'restore',
    );
    expect(restoreCall).toBeDefined();
    // stdio is [stdin, stdout, stderr]; stdout/stderr must be piped so
    // litestream's output is captured rather than sent to the pod's stdout.
    expect(restoreCall?.[2]?.stdio).toEqual(['ignore', 'pipe', 'pipe']);
  });

  // The change log is a local cache that is deliberately not backed up: it
  // holds nothing that is not already in the replica's backup or re-derivable
  // from the upstream slot, and shipping it would give back the S3 and
  // follower-download savings the separate file exists to win.
  test('the rendered litestream config never backs up the change-log database', () => {
    const replica = join(
      mkdtempSync(join(tmpdir(), 'litestream-config-test-')),
      'replica.db',
    );
    const {litestream} = configWithFakeLitestream(
      {kind: 'exit', code: 0},
      replica,
    );
    // The variables `getLitestream` substitutes into the config it hands
    // litestream; `ZERO_REPLICA_FILE` is always the replica, never a path
    // derived from it.
    const env: Record<string, string> = {
      ZERO_REPLICA_FILE: replica,
      ZERO_LITESTREAM_BACKUP_URL: must(litestream.backupURL),
    };
    const yaml = readFileSync(
      new URL('./config.yml', import.meta.url),
      'utf-8',
    ).replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');

    const paths = Array.from(
      yaml.matchAll(/^\s*-?\s*path:\s*(\S+)\s*$/gm),
      ([, path]) => path,
    );
    expect(paths).toEqual([replica]);
    expect(paths).not.toContain(changeLogFileName(replica));
  });
});
