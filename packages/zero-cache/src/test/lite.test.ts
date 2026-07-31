import {existsSync} from 'node:fs';
import {expect, test} from 'vitest';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {DbFile} from './lite.ts';

// These cover the invariant rather than the symptom: DbFile hands out
// connections, so DbFile is what closes them. Windows cannot unlink a file with
// an open handle, and POSIX can — so a delete() that left handles open worked on
// POSIX and could not work on Windows. Asserting the handles are closed makes
// the guarantee hold on both.

const lc = createSilentLogContext();

function seed(file: DbFile): void {
  const db = file.connect(lc);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  db.close();
}

test('delete removes the database file', () => {
  const file = new DbFile('lite-test-removes');
  seed(file);
  expect(existsSync(file.path)).toBe(true);

  file.delete();
  expect(existsSync(file.path)).toBe(false);
});

test('delete removes the sidecars, which only exist while a connection is open', () => {
  const file = new DbFile('lite-test-sidecars');
  const db = file.connect(lc);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');

  // The connection stays open on purpose. SQLite removes -wal and -shm on a
  // clean close, so closing first would leave nothing for delete() to remove and
  // the assertion below would hold over an empty set. Asserting they exist first
  // is what makes the second assertion mean something.
  expect(existsSync(`${file.path}-wal`)).toBe(true);
  expect(existsSync(`${file.path}-shm`)).toBe(true);

  file.delete();

  // Written out rather than iterating the production constant: sharing it lets a
  // dropped suffix stop being checked at the same moment it stops being removed.
  for (const suffix of ['', '-wal', '-wal2', '-shm', '-journal']) {
    expect(existsSync(`${file.path}${suffix}`)).toBe(false);
  }
});

test('delete closes a connection the caller left open', () => {
  const file = new DbFile('lite-test-closes-open');
  const db = file.connect(lc);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');

  // Deliberately not closed by the caller — this is the case that failed on
  // Windows with EPERM, and the reason closing belongs here.
  file.delete();

  expect(() => db.prepare('SELECT 1')).toThrow(/not open/i);
  expect(existsSync(file.path)).toBe(false);
});

test('delete closes every connection handed out, not just the last', () => {
  const file = new DbFile('lite-test-closes-all');
  const first = file.connect(lc);
  first.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  const second = file.connect(lc);
  const third = file.connect(lc);

  file.delete();

  // The structural claim: tracking is per-connection. A fix that only closed
  // the most recent one would pass the previous test and fail this.
  for (const db of [first, second, third]) {
    expect(() => db.prepare('SELECT 1')).toThrow(/not open/i);
  }
  expect(existsSync(file.path)).toBe(false);
});

test('delete tolerates a caller that already closed its own connection', () => {
  const file = new DbFile('lite-test-double-close');
  const db = file.connect(lc);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  db.close();

  expect(() => file.delete()).not.toThrow();
  expect(existsSync(file.path)).toBe(false);
});

test('delete is idempotent and does not re-close stale connections', () => {
  const file = new DbFile('lite-test-idempotent');
  seed(file);

  file.delete();
  // The tracked set is drained on the first call, so a second delete has
  // nothing to close and no file to remove.
  expect(() => file.delete()).not.toThrow();
  expect(existsSync(file.path)).toBe(false);
});

test('a connection opened after delete is tracked by the next delete', () => {
  const file = new DbFile('lite-test-reopen');
  seed(file);
  file.delete();

  const reopened = file.connect(lc);
  reopened.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  file.delete();

  expect(() => reopened.prepare('SELECT 1')).toThrow(/not open/i);
  expect(existsSync(file.path)).toBe(false);
});
