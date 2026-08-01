import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  type RmOptions,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test, vi} from 'vitest';
import {SQLITE_FILE_SUFFIXES} from '../../../shared/src/sqlite-file-suffixes.ts';
import {
  ASYNC_REMOVE_DEADLINE_MS,
  SYNC_RETRY_BUDGET,
  deleteLiteDB,
  deleteLiteDBAsync,
} from './delete-lite-db.ts';

// The suffixes are written out literally rather than taken from the module.
// Seeding a fixture from the same constant an assertion iterates makes the two
// agree by construction: dropping a suffix would stop creating that file AND stop
// looking for it, so the test would pass while the production loop silently left a
// file behind.
const EXPECTED_SUFFIXES = ['', '-wal', '-wal2', '-shm', '-journal'];

test('covers every file a SQLite database can consist of', () => {
  // `-journal` is the one worth stating: the replica runs in WAL2, but `prepare()`
  // switches to `journal_mode = delete` and the version-history write runs at the
  // connection default, so an interrupted run leaves a rollback journal.
  expect([...SQLITE_FILE_SUFFIXES]).toEqual(EXPECTED_SUFFIXES);
});

function makeDbWithSidecars(): string {
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  const dbFile = join(dir, 'replica.db');
  for (const suffix of EXPECTED_SUFFIXES) {
    writeFileSync(`${dbFile}${suffix}`, '');
  }
  return dbFile;
}

/** Records what was asked of it; fails the paths named in `failOn`. */
function recordingRemover(failOn: readonly string[] = []) {
  const calls: {path: string; options: RmOptions}[] = [];
  const remove = (path: string, options: RmOptions) => {
    calls.push({path, options});
    if (failOn.some(suffix => path.endsWith(suffix))) {
      throw Object.assign(new Error(`EBUSY: ${path}`), {code: 'EBUSY'});
    }
  };
  return {calls, remove};
}

test('deletes the database and every sidecar', () => {
  const dbFile = makeDbWithSidecars();
  deleteLiteDB(dbFile);
  const remaining = EXPECTED_SUFFIXES.filter(suffix =>
    existsSync(`${dbFile}${suffix}`),
  );
  expect(remaining).toEqual([]);
});

test('is a no-op when nothing is there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  expect(() => deleteLiteDB(join(dir, 'absent.db'))).not.toThrow();
});

test('refuses a directory rather than removing one, before removing anything', () => {
  // The paths come from operator config, so this is reachable by misconfiguration.
  // The check runs over every path first: rejecting one mid-loop would leave the
  // database half-deleted, and the callers recreate it immediately.
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  const dbFile = join(dir, 'replica.db');
  writeFileSync(dbFile, '');
  writeFileSync(`${dbFile}-wal`, '');
  // A directory at a path deleteLiteDB visits, and NOT the first one: if the guard
  // ran per-iteration the two files before it would already be gone.
  mkdirSync(`${dbFile}-shm`);

  const {calls, remove} = recordingRemover();
  expect(() => deleteLiteDB(dbFile, 'linux', remove)).toThrow(/is a directory/);
  expect(calls).toEqual([]);
  expect(existsSync(dbFile)).toBe(true);
  expect(existsSync(`${dbFile}-wal`)).toBe(true);
});

test.each([
  ['linux', {force: true, recursive: false, maxRetries: 0, retryDelay: 0}],
  ['darwin', {force: true, recursive: false, maxRetries: 0, retryDelay: 0}],
  ['win32', {force: true, recursive: true, maxRetries: 5, retryDelay: 20}],
] as const)('passes the %s removal options', (platform, expected) => {
  // POSIX must not retry: EPERM, ENOTEMPTY, EMFILE and ENFILE all occur there
  // legitimately and no delay can fix them, since rmSync is synchronous. And
  // `recursive` rides with the budget — where nothing is retried it only costs the
  // kernel's own refusal to unlink a directory.
  const {calls, remove} = recordingRemover();
  deleteLiteDB('/tmp/replica.db', platform, remove);
  expect(calls).toHaveLength(EXPECTED_SUFFIXES.length);
  for (const call of calls) {
    expect(call.options).toEqual(expected);
  }
});

test('attempts every suffix, then reports the failures together', () => {
  // Stopping at the first failure leaves a sidecar beside a database the caller
  // recreates, which SQLite then tries to recover into the fresh file.
  const {calls, remove} = recordingRemover(['-wal', '-journal']);
  let caught: unknown;
  try {
    deleteLiteDB('/tmp/replica.db', 'linux', remove);
  } catch (error) {
    caught = error;
  }
  expect(calls.map(c => c.path)).toEqual(
    EXPECTED_SUFFIXES.map(s => `/tmp/replica.db${s}`),
  );
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toHaveLength(2);
});

// The awaited sibling. Its reason for existing is a retry budget that can only
// work asynchronously: `rmSync` blocks the loop that would release the handle it
// is waiting for, so on Windows it can spin out its whole budget against a file
// nothing is free to unlock. Measured there, a replica a synchronous loop could
// not remove in 30 seconds and 600 attempts is removed on the second async try.

test('async: deletes the database and every sidecar', async () => {
  const dbFile = makeDbWithSidecars();
  await deleteLiteDBAsync(dbFile);
  const remaining = EXPECTED_SUFFIXES.filter(suffix =>
    existsSync(`${dbFile}${suffix}`),
  );
  expect(remaining).toEqual([]);
});

test('async: is a no-op when nothing is there', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  await expect(
    deleteLiteDBAsync(join(dir, 'absent.db')),
  ).resolves.toBeUndefined();
});

test('async: refuses a directory before removing anything', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  const dbFile = join(dir, 'replica.db');
  writeFileSync(dbFile, '');
  mkdirSync(`${dbFile}-shm`);

  await expect(deleteLiteDBAsync(dbFile)).rejects.toThrow(/is a directory/);
  // Refused up front, so the database it would have orphaned is still there.
  expect(existsSync(dbFile)).toBe(true);
});

test('async: attempts every suffix, then reports the failures together', async () => {
  const attempted: string[] = [];
  const failing = (path: string): Promise<void> => {
    attempted.push(path);
    return Promise.reject(
      Object.assign(new Error(`EPERM: ${path}`), {code: 'EPERM'}),
    );
  };

  const file = join(mkdtempSync(join(tmpdir(), 'delete-lite-db-')), 'r.db');
  let caught: unknown;
  vi.useFakeTimers();
  try {
    const removing = deleteLiteDBAsync(file, 'win32', failing).catch(e => e);
    await vi.advanceTimersByTimeAsync(ASYNC_REMOVE_DEADLINE_MS + 1_000);
    caught = await removing;
  } finally {
    vi.useRealTimers();
  }

  // The first pass covers every suffix; later passes re-attempt the ones still
  // held, which here is all of them.
  expect(attempted.slice(0, SQLITE_FILE_SUFFIXES.length)).toEqual(
    SQLITE_FILE_SUFFIXES.map(s => `${file}${s}`),
  );
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toHaveLength(
    SQLITE_FILE_SUFFIXES.length,
  );
  // The first failure's text reaches the message, not just the errors array.
  expect((caught as AggregateError).message).toContain('EPERM');
});

test('async: retries itself rather than handing rm a per-file budget', async () => {
  // The budget has to be one deadline for the database. `rm`'s own is per call, so
  // five sidecars multiply it, and a wait long enough for the last file stops
  // fitting inside the timeout of whatever is waiting.
  const seen: RmOptions[] = [];
  const record = (_path: string, options: RmOptions): Promise<void> => {
    seen.push(options);
    return Promise.resolve();
  };

  const file = join(mkdtempSync(join(tmpdir(), 'delete-lite-db-')), 'r.db');
  await deleteLiteDBAsync(file, 'win32', record);

  expect(seen).toHaveLength(SQLITE_FILE_SUFFIXES.length);
  for (const options of seen) {
    expect(options.maxRetries).toBe(0);
  }
  // And the deadline is worth more than the blocking budget, since waiting costs
  // nothing here — a value at or below it would make this no better than the
  // synchronous path.
  expect(ASYNC_REMOVE_DEADLINE_MS).toBeGreaterThan(
    SYNC_RETRY_BUDGET.maxRetries * SYNC_RETRY_BUDGET.retryDelay,
  );
});

test('async: keeps trying a held file, and only that file, until it goes', async () => {
  // The behaviour the deadline buys: a handle a departing process is about to drop
  // becomes free a moment later, and only the paths still held are re-attempted.
  const attempts: string[] = [];
  let held = 3;
  const file = join(mkdtempSync(join(tmpdir(), 'delete-lite-db-')), 'r.db');
  const wal = `${file}-wal`;
  const flaky = (path: string): Promise<void> => {
    attempts.push(path);
    if (path === wal && held-- > 0) {
      return Promise.reject(
        Object.assign(new Error(`EBUSY: ${path}`), {code: 'EBUSY'}),
      );
    }
    return Promise.resolve();
  };

  await expect(
    deleteLiteDBAsync(file, 'win32', flaky),
  ).resolves.toBeUndefined();

  // Every path once on the first pass, then the held one alone until it succeeds.
  expect(attempts.filter(p => p === wal)).toHaveLength(4);
  expect(attempts.filter(p => p === file)).toHaveLength(1);
});

test('async: reports what is still held once the deadline passes', async () => {
  // Bounded: a handle nobody will release does not become releasable with more
  // waiting, and a wait that outlasts its caller reports nothing useful.
  const stuck = (path: string): Promise<void> =>
    Promise.reject(Object.assign(new Error(`EBUSY: ${path}`), {code: 'EBUSY'}));

  const file = join(mkdtempSync(join(tmpdir(), 'delete-lite-db-')), 'r.db');
  vi.useFakeTimers();
  try {
    const removing = deleteLiteDBAsync(file, 'win32', stuck).catch(e => e);
    await vi.advanceTimersByTimeAsync(ASYNC_REMOVE_DEADLINE_MS + 1_000);
    const error = await removing;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain('EBUSY');
  } finally {
    vi.useRealTimers();
  }
});
