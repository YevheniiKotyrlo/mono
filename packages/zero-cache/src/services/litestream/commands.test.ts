import * as childProcess from 'node:child_process';
import {EventEmitter} from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  mkdirSync,
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
  startReplicaBackupProcess,
  tryRestore,
} from './commands.ts';
import * as litestreamMetrics from './metrics.ts';

// Replace node:child_process.spawn so the args it was called with can be
// asserted and the child it returns is stood up in process. Node's built-in
// module exports are non-configurable, so vi.spyOn cannot be used here.
//
// A mock with no default implementation is deliberate: every case installs its
// own, and a case that did not would otherwise spawn the executable its config
// names, which is a path that was never created.
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return {...actual, spawn: vi.fn()};
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
  | {kind: 'restore'; copyFrom?: string}
  /**
   * A restore that refuses when the destination already carries staged
   * artifacts, and otherwise succeeds by copying — litestream's own refusal to
   * restore on top of a half-finished attempt. The suffixes are appended to the
   * staging path, so `''` names the staged database itself.
   */
  | {
      kind: 'restore-unless-staged';
      stagedSuffixes: readonly string[];
      refuseWith: number;
      copyFrom: string;
    }
  /**
   * A restore that fails having left staged artifacts behind, which is the state
   * the production cleanup exists to clear.
   */
  | {
      kind: 'restore-leaving-staged';
      stagedSuffixes: readonly string[];
      code: number;
    }
  /**
   * A restore that fails leaving a DIRECTORY at each staging path.
   *
   * The cleanup unlinks those paths without `recursive`, so it cannot remove a
   * directory and throws — which is the cleanup-error-precedence case: the
   * restore error is what the operator needs, and it has to survive a cleanup
   * that failed on the way out.
   */
  | {
      kind: 'restore-fails';
      stdout: string;
      stderr: string;
      code: number;
      stagedDirectorySuffixes: readonly string[];
    };

/** Where litestream stages a restore before moving it into place. */
function stagingPath(destination: string, suffix: string): string {
  return `${destination}.tmp${suffix}`;
}

/**
 * Stands in for a spawned `litestream`, implementing only what the production
 * code consumes: encoded stdout/stderr, `error`/`close`, and `kill`.
 */
function fakeChild(
  behaviour: FakeLitestream,
  args: readonly string[],
  options: Pick<childProcess.SpawnOptions, 'stdio'> = {},
) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough | null;
    stderr: PassThrough | null;
    kill: ReturnType<typeof vi.fn<(signal?: NodeJS.Signals) => boolean>>;
  };

  // A stream exists only for a piped slot, so code that reads an inherited one
  // fails here as it would in production.
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
  //
  // The close is deferred: a real process exits asynchronously, so a handler
  // that runs inside the `kill()` call observes state the caller has not
  // finished updating, and an interleaving that production has cannot occur.
  child.kill = vi.fn((signal?: NodeJS.Signals) => {
    setImmediate(() => close(null, signal ?? 'SIGKILL'));
    return true;
  });

  // A child outlives the case that made it whenever the case does not await its
  // close, and its arm writes into the directory the hook is about to remove.
  // Disposal is explicit rather than inferred from `done`, which says the child
  // closed and not that the case is over.
  let disposed = false;
  liveChildren.push(() => {
    disposed = true;
  });

  const subcommand = args[0];
  setImmediate(() => {
    if (done || disposed) {
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
      // The restore target is the trailing argument — the only one that is
      // neither a flag nor a flag's value — so these survive another flag being
      // added ahead of it, which an index would not.
      case 'restore':
        if (subcommand === 'restore') {
          if (behaviour.copyFrom !== undefined) {
            copyFileSync(behaviour.copyFrom, must(args.at(-1)));
          }
          close(0, null);
        } else {
          close(1, null);
        }
        break;
      case 'restore-unless-staged': {
        if (subcommand !== 'restore') {
          close(1, null);
          break;
        }
        const destination = must(args.at(-1));
        const staged = behaviour.stagedSuffixes.some(suffix =>
          existsSync(stagingPath(destination, suffix)),
        );
        if (staged) {
          close(behaviour.refuseWith, null);
          break;
        }
        copyFileSync(behaviour.copyFrom, destination);
        close(0, null);
        break;
      }
      case 'restore-leaving-staged': {
        if (subcommand !== 'restore') {
          close(1, null);
          break;
        }
        const destination = must(args.at(-1));
        for (const suffix of behaviour.stagedSuffixes) {
          writeFileSync(stagingPath(destination, suffix), 'staged');
        }
        close(behaviour.code, null);
        break;
      }
      case 'restore-fails': {
        if (subcommand !== 'restore') {
          close(1, null);
          break;
        }
        const destination = must(args.at(-1));
        for (const suffix of behaviour.stagedDirectorySuffixes) {
          mkdirSync(stagingPath(destination, suffix), {recursive: true});
        }
        child.stdout?.write(`${behaviour.stdout}\n`);
        child.stderr?.write(`${behaviour.stderr}\n`);
        close(behaviour.code, null);
        break;
      }
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
/** Every directory a case makes, removed after the case that made it. */
const ownedDirs: string[] = [];

/** Every fake child a case spawns, disposed after the case that spawned it. */
const liveChildren: (() => void)[] = [];

afterEach(() => {
  // Children first: a live child's arm writes into one of these directories.
  for (const dispose of liveChildren.splice(0)) {
    dispose();
  }
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, {recursive: true, force: true});
  }
});

/**
 * A temp directory owned by the running case, removed when the case ends.
 *
 * `mkdtempSync` on its own leaves one behind per case, so a suite that makes one
 * per case leaves a directory per case in the system temp directory.
 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ownedDirs.push(dir);
  return dir;
}

function configWithFakeLitestream(
  behaviour: FakeLitestream,
  replicaFile?: string,
  litestreamOverrides?: Record<string, unknown>,
): NormalizedZeroConfig {
  // The executable is never resolved and no replica is opened — the child is
  // faked. The directory is real and unique per call all the same, because the
  // staging behaviours above write into it: a shared path would carry a staged
  // artifact from one case into the next, where it decides the outcome. Removed
  // in the hook below.
  const dir = tempDir('litestream-test-fake-');
  const executable = join(dir, 'fake-litestream');
  vi.mocked(childProcess.spawn).mockReset();
  vi.mocked(childProcess.spawn).mockImplementation(((
    _command: string,
    args: readonly string[],
    options: Pick<childProcess.SpawnOptions, 'stdio'>,
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
      configPathV5: './src/services/litestream/config-v5.yml',
      logLevel: 'warn',
      restoreUsingV5: false,
      checkpointThresholdMB: 40,
      incrementalBackupIntervalMinutes: 15,
      incrementalBackupIntervalSeconds: 15,
      snapshotBackupIntervalHours: 12,
      multipartConcurrency: 48,
      multipartSize: 16 * 1024 * 1024,
      restoreParallelism: 48,
      ...litestreamOverrides,
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

const SQLITE_FAMILY_SUFFIXES = ['', '-wal', '-wal2', '-shm', '-journal'];

function sqliteFamilyFiles(file: string) {
  return SQLITE_FAMILY_SUFFIXES.map(suffix => `${file}${suffix}`);
}

function writeSQLiteFamily(file: string, contents = 'test data') {
  for (const familyFile of sqliteFamilyFiles(file)) {
    writeFileSync(familyFile, contents);
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
    //
    // The listing runs both subcommands concurrently and both hang, so both
    // children have to be killed. Which one `at(-1)` names depends on the order
    // `Promise.all` evaluated its arguments in, so every child is asserted.
    const {results} = vi.mocked(childProcess.spawn).mock;
    expect(results.length).toBe(2);
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
    const dir = tempDir('litestream-restore-test-');
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
    const dir = tempDir('litestream-restore-test-');
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
    const dir = tempDir('litestream-restore-test-');
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
    const dir = tempDir('litestream-restore-test-');
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

  test('deletes a stale temporary SQLite family before restore', async () => {
    const dir = tempDir('litestream-restore-test-');
    const source = join(dir, 'source.db');
    const replica = join(dir, 'replica.db');
    const temporaryReplica = `${replica}.tmp`;
    const stagedWAL = `${temporaryReplica}-deadbeef-wal`;
    createRestorableReplica(source, '01');
    writeSQLiteFamily(temporaryReplica);
    writeFileSync(stagedWAL, 'stale WAL data');
    const {litestream} = configWithFakeLitestream(
      {
        kind: 'restore-unless-staged',
        stagedSuffixes: [
          '',
          '-wal',
          '-wal2',
          '-shm',
          '-journal',
          '-deadbeef-wal',
        ],
        refuseWith: 9,
        copyFrom: source,
      },
      replica,
    );

    await expect(
      tryRestore(
        lc,
        litestream,
        replica,
        {replicaVersion: '01', minWatermark: '01'},
        'replication_manager',
      ),
    ).resolves.toMatchObject({restored: true, result: 'success'});

    expect(sqliteFamilyFiles(temporaryReplica).some(existsSync)).toBe(false);
    expect(existsSync(stagedWAL)).toBe(false);
  });

  test('deletes a temporary SQLite family left by a failed restore', async () => {
    const dir = tempDir('litestream-restore-test-');
    const replica = join(dir, 'replica.db');
    const temporaryReplica = `${replica}.tmp`;
    const stagedWAL = `${temporaryReplica}-deadbeef-wal`;
    const {litestream} = configWithFakeLitestream(
      {
        kind: 'restore-leaving-staged',
        stagedSuffixes: [
          '',
          '-wal',
          '-wal2',
          '-shm',
          '-journal',
          '-deadbeef-wal',
        ],
        code: 1,
      },
      replica,
    );

    await expect(
      tryRestore(
        lc,
        litestream,
        replica,
        {replicaVersion: '01', minWatermark: '01'},
        'replication_manager',
      ),
    ).rejects.toThrow('litestream exited with code 1');

    expect(sqliteFamilyFiles(temporaryReplica).some(existsSync)).toBe(false);
    expect(existsSync(stagedWAL)).toBe(false);
  });

  test('temporary restore cleanup preserves the real replica family', async () => {
    const dir = tempDir('litestream-restore-test-');
    const replica = join(dir, 'replica.db');
    const temporaryReplica = `${replica}.tmp`;
    writeSQLiteFamily(replica, 'real replica');
    const {litestream} = configWithFakeLitestream(
      {
        kind: 'restore-leaving-staged',
        stagedSuffixes: ['', '-journal'],
        code: 1,
      },
      replica,
    );

    await expect(
      tryRestore(
        lc,
        litestream,
        replica,
        {replicaVersion: '01', minWatermark: '01'},
        'replication_manager',
      ),
    ).rejects.toThrow('litestream exited with code 1');

    for (const familyFile of sqliteFamilyFiles(replica)) {
      expect(readFileSync(familyFile, 'utf8')).toBe('real replica');
    }
    expect(sqliteFamilyFiles(temporaryReplica).some(existsSync)).toBe(false);
  });

  test('logs restore directory contents before and after temporary cleanup', async () => {
    const sink = new TestLogSink();
    const loggingLC = new LogContext('debug', undefined, sink);
    const dir = tempDir('litestream-restore-test-');
    const source = join(dir, 'source.db');
    const replica = join(dir, 'replica.db');
    const temporaryReplica = `${replica}.tmp`;
    const unexpectedFile = join(dir, 'unexpected-restore-file');
    createRestorableReplica(source, '01');
    writeFileSync(temporaryReplica, 'stale temporary data');
    writeFileSync(unexpectedFile, 'unexpected data');
    const {litestream} = configWithFakeLitestream(
      {kind: 'restore', copyFrom: source},
      replica,
    );

    await tryRestore(
      loggingLC,
      litestream,
      replica,
      {replicaVersion: '01', minWatermark: '01'},
      'replication_manager',
    );

    const snapshots = sink.messages
      .filter(
        ([, , args]) => args[0] === 'Litestream restore directory contents',
      )
      .map(
        ([, , args]) =>
          args[1] as {
            phase: string;
            entryCount: number;
            entries: {name: string; sizeBytes: number}[];
          },
      );
    expect(snapshots.map(snapshot => snapshot.phase)).toEqual([
      'before-temp-cleanup',
      'after-temp-cleanup',
    ]);
    expect(snapshots[0]?.entries).toContainEqual(
      expect.objectContaining({
        name: 'replica.db.tmp',
        sizeBytes: 20,
      }),
    );
    expect(snapshots[1]?.entries.map(entry => entry.name)).not.toContain(
      'replica.db.tmp',
    );
    for (const snapshot of snapshots) {
      expect(snapshot.entryCount).toBeGreaterThan(0);
      expect(snapshot.entries).toContainEqual(
        expect.objectContaining({
          name: 'unexpected-restore-file',
          sizeBytes: 15,
        }),
      );
    }
  });

  test('includes captured output when restore fails', async () => {
    const sink = new TestLogSink();
    const restoreLc = new LogContext('debug', undefined, sink);
    const {litestream, replica} = configWithFakeLitestream({
      kind: 'restore-fails',
      stdout: 'restore stdout',
      stderr: 'restore stderr',
      code: 1,
      // A directory, which the cleanup cannot unlink: this case is also the one
      // that proves a failing cleanup does not replace the error below.
      stagedDirectorySuffixes: [''],
    });

    const error = await tryRestore(
      restoreLc,
      litestream,
      replica.file,
      {replicaVersion: '01', minWatermark: '01'},
      'replication_manager',
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('litestream exited with code 1');
    expect(String(error)).toContain('restore stdout');
    expect(String(error)).toContain('restore stderr');
    // The cleanup did fail, and said so rather than taking the error's place.
    expect(
      sink.messages.some(
        ([level, , args]) =>
          level === 'warn' &&
          args.some(
            a =>
              typeof a === 'string' &&
              a.includes(
                'Unable to clean up Litestream restore temporary files',
              ),
          ),
      ),
    ).toBe(true);
  });

  test('deletes an incompatible restored replica', async () => {
    const dir = tempDir('litestream-restore-test-');
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
    const dir = tempDir('litestream-restore-test-');
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

  // The v3/v5 fork is a silent one: v5 keys (l0-retention, levels,
  // monitor-interval, ...) live only in config-v5.yml, so selecting the wrong
  // file makes them no-ops with no error. Pin the mapping in both directions
  // so a regression (e.g. inverting the `v5 ? configPathV5 : configPath`
  // ternary) fails loudly.
  async function litestreamConfigForRestore(
    restoreUsingV5: boolean,
  ): Promise<string | undefined> {
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockClear();
    const dir = tempDir('litestream-restore-test-');
    const source = join(dir, 'source.db');
    const replica = join(dir, 'replica.db');
    createRestorableReplica(source, '01');
    const {litestream} = configWithFakeLitestream(
      {kind: 'restore', copyFrom: source},
      replica,
      {restoreUsingV5},
    );

    await tryRestore(
      lc,
      litestream,
      replica,
      {replicaVersion: '01', minWatermark: '01'},
      'replication_manager',
    );

    const restoreCall = spawnMock.mock.calls.find(
      call => Array.isArray(call[1]) && call[1][0] === 'restore',
    );
    return restoreCall?.[2]?.env?.LITESTREAM_CONFIG;
  }

  test('restore uses the v5 config when restoreUsingV5 is set', async () => {
    expect(await litestreamConfigForRestore(true)).toBe(
      './src/services/litestream/config-v5.yml',
    );
  });

  test('restore uses the v3 config when restoreUsingV5 is not set', async () => {
    expect(await litestreamConfigForRestore(false)).toBe(
      './src/services/litestream/config.yml',
    );
  });

  // The change log is a local cache that is deliberately not backed up: it
  // holds nothing that is not already in the replica's backup or re-derivable
  // from the upstream slot, and shipping it would give back the S3 and
  // follower-download savings the separate file exists to win.
  test('the rendered litestream config never backs up the change-log database', () => {
    const replica = join(tempDir('litestream-config-test-'), 'replica.db');
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

  // Same invariant as above, for the v5 config we now render.
  test('the rendered v5 litestream config never backs up the change-log database', () => {
    const replica = join(tempDir('litestream-config-test-'), 'replica.db');
    const {litestream} = configWithFakeLitestream(
      {kind: 'exit', code: 0},
      replica,
    );
    const env: Record<string, string> = {
      ZERO_REPLICA_FILE: replica,
      ZERO_LITESTREAM_BACKUP_URL: must(litestream.backupURL),
    };
    const yaml = readFileSync(
      new URL('./config-v5.yml', import.meta.url),
      'utf-8',
    ).replace(/\$\{(\w+)\}/g, (_, name: string) => env[name] ?? '');

    const paths = Array.from(
      yaml.matchAll(/^\s*-?\s*path:\s*(\S+)\s*$/gm),
      ([, path]) => path,
    );
    expect(paths).toEqual([replica]);
    expect(paths).not.toContain(changeLogFileName(replica));
  });

  // forceCheckpointThresholdMB and litestream's own truncate-page-n emergency
  // break are mutually exclusive: whichever one is doing the job, the other
  // must be off, or a stuck TRUNCATE checkpoint could still block writes for
  // as long as the app's forced checkpoint is meant to prevent.
  function truncatePageNForReplicate(
    forceCheckpointThresholdMB: number,
  ): string | undefined {
    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockClear();
    const {litestream, replica} = configWithFakeLitestream(
      {kind: 'exit', code: 0},
      undefined,
      {forceCheckpointThresholdMB},
    );

    startReplicaBackupProcess(lc, litestream, replica.file);

    const replicateCall = spawnMock.mock.calls.find(
      call => Array.isArray(call[1]) && call[1][0] === 'replicate',
    );
    return replicateCall?.[2]?.env?.ZERO_LITESTREAM_TRUNCATE_PAGE_N;
  }

  test('disables litestream truncate-page-n when forceCheckpointThresholdMB is set', () => {
    expect(truncatePageNForReplicate(256)).toBe('-1');
  });

  test('uses litestream default truncate-page-n when forceCheckpointThresholdMB is disabled', () => {
    expect(truncatePageNForReplicate(0)).toBe('121359');
  });

  // Regression guard for a silent misconfiguration: `monitor-interval` is a
  // DB-level key (it governs L0/LTX creation cadence). Nested under `replica:`
  // it is an unknown key that litestream's non-strict YAML parser ignores, so
  // the backup interval silently reverts to the 1s default. Assert it sits at
  // the same indentation as `replica:` (a sibling under the db entry), not
  // deeper.
  test('config-v5.yml places monitor-interval at the db level, not under replica', () => {
    const yaml = readFileSync(
      new URL('./config-v5.yml', import.meta.url),
      'utf-8',
    );
    const indentOf = (line: string) => line.length - line.trimStart().length;

    const replicaLine = yaml
      .split('\n')
      .find(line => /^\s*replica:\s*$/.test(line));
    const monitorLine = yaml
      .split('\n')
      .find(line => /^\s*monitor-interval:/.test(line));

    expect(replicaLine).toBeDefined();
    expect(monitorLine).toBeDefined();
    // Sibling of `replica:` => nested one level under the `- path:` db entry.
    expect(indentOf(must(monitorLine))).toBe(indentOf(must(replicaLine)));
  });
});
