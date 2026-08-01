import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  type RmOptions,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'vitest';
import {SQLITE_FILE_SUFFIXES} from '../../../shared/src/sqlite-file-suffixes.ts';
import {
  ASYNC_RETRY_BUDGET,
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
  try {
    await deleteLiteDBAsync(file, 'win32', failing);
  } catch (error) {
    caught = error;
  }

  expect(attempted).toEqual(SQLITE_FILE_SUFFIXES.map(s => `${file}${s}`));
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toHaveLength(
    SQLITE_FILE_SUFFIXES.length,
  );
  // The first failure's text reaches the message, not just the errors array.
  expect((caught as AggregateError).message).toContain('EPERM');
});

test('async: spends a real retry budget on Windows and none elsewhere', async () => {
  // The whole point of the async variant: retries that the loop can run between.
  // A budget of zero would make it identical to the synchronous one.
  const seen: RmOptions[] = [];
  const record = (_path: string, options: RmOptions): Promise<void> => {
    seen.push(options);
    return Promise.resolve();
  };

  const budgetFile = join(
    mkdtempSync(join(tmpdir(), 'delete-lite-db-')),
    'r.db',
  );
  await deleteLiteDBAsync(budgetFile, 'win32', record);
  // Against the synchronous budget rather than a literal: the invariant is that
  // waiting asynchronously is worth more than waiting synchronously, and a
  // hard-coded floor keeps passing if the two are ever collapsed onto one value.
  expect(seen[0].maxRetries).toBeGreaterThan(SYNC_RETRY_BUDGET.maxRetries);
  expect(ASYNC_RETRY_BUDGET.maxRetries).toBeGreaterThan(
    SYNC_RETRY_BUDGET.maxRetries,
  );

  seen.length = 0;
  await deleteLiteDBAsync(budgetFile, 'linux', record);
  expect(seen[0].maxRetries).toBe(0);
});
