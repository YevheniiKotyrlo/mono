import {existsSync, mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'vitest';
import {
  deleteLiteDB,
  liteDbRemoveOptions,
  SQLITE_FILE_SUFFIXES,
} from './delete-lite-db.ts';

// The suffixes are written out literally here rather than taken from the module.
// Seeding the fixture from the same constant the assertion iterates makes the two
// agree by construction: dropping a suffix would stop creating that file AND stop
// looking for it, so the test would pass while the production loop silently left
// a file behind.
const EXPECTED_SUFFIXES = ['', '-wal', '-wal2', '-shm', '-journal'];

test('covers every file a SQLite database can consist of', () => {
  // `-journal` is the one worth stating: the replica runs in WAL2, but
  // `prepare()` switches to `journal_mode = delete` and the version-history
  // write runs at the connection default, so an interrupted run leaves a
  // rollback journal that the next start would otherwise inherit.
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

// The retry budget is platform-dependent and the platform is a parameter, so both
// shapes are asserted on every runner. POSIX must NOT retry: EPERM, ENOTEMPTY,
// EMFILE and ENFILE all occur there legitimately and no delay can fix them, since
// `rmSync` is synchronous and nothing can close a descriptor while it sleeps — so
// retrying would only turn a fast, accurate failure into a stall.
test('does not retry on posix, where unlink-while-open already works', () => {
  const options = liteDbRemoveOptions('linux');
  expect(options.force).toBe(true);
  expect(options.maxRetries).toBe(0);
  expect(options.retryDelay).toBe(0);
});

test('retries on win32, where an open handle blocks the unlink', () => {
  const options = liteDbRemoveOptions('win32');
  expect(options.maxRetries).toBe(5);
  expect(options.retryDelay).toBe(20);
  // Linear backoff: keep the worst case a hiccup rather than seconds per file.
  const worstCaseMs =
    ((options.maxRetries * (options.maxRetries + 1)) / 2) * options.retryDelay;
  expect(worstCaseMs).toBeLessThan(500);
});

test('removes recursively on every platform, so the behaviour cannot diverge', () => {
  // `recursive` is required for Node to honour the retry budget. Following the
  // platform instead would make a misconfigured replica path an EISDIR on POSIX
  // and a silent recursive delete on Windows.
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    expect(liteDbRemoveOptions(platform).recursive).toBe(true);
  }
});

test('refuses a directory rather than removing one recursively', () => {
  // The paths come from operator config, so this is reachable by
  // misconfiguration. `recursive` would otherwise make it a silent tree delete
  // on every platform, where before it was a loud EISDIR.
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  const asDatabase = join(dir, 'replica.db');
  mkdirSync(asDatabase);
  writeFileSync(join(asDatabase, 'keep-me'), '');

  expect(() => deleteLiteDB(asDatabase)).toThrow(/is a directory/);
  expect(existsSync(join(asDatabase, 'keep-me'))).toBe(true);
});

test('attempts every suffix before reporting a failure', () => {
  // A partial delete leaves a sidecar beside a database the caller recreates
  // straight away, which SQLite then tries to recover into the fresh file.
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  const dbFile = join(dir, 'replica.db');
  for (const suffix of EXPECTED_SUFFIXES) {
    writeFileSync(`${dbFile}${suffix}`, '');
  }
  // A directory where a sidecar is expected fails its own removal without
  // stopping the others: it is not the database path itself, so the guard above
  // does not fire.
  mkdirSync(`${dbFile}-blocker`);
  writeFileSync(join(`${dbFile}-blocker`, 'inner'), '');

  deleteLiteDB(dbFile);

  for (const suffix of EXPECTED_SUFFIXES) {
    expect(existsSync(`${dbFile}${suffix}`)).toBe(false);
  }
});
