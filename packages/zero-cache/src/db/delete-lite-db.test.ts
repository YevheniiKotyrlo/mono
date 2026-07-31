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
import {deleteLiteDB} from './delete-lite-db.ts';

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
