import {existsSync} from 'node:fs';
import {expect, test, vi} from 'vitest';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import * as deleteLiteDb from '../db/delete-lite-db.ts';
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

test('delete removes the database file', async () => {
  const file = new DbFile('lite-test-removes');
  seed(file);
  expect(existsSync(file.path)).toBe(true);

  await file.delete();
  expect(existsSync(file.path)).toBe(false);
});

test('delete removes the sidecars, which only exist while a connection is open', async () => {
  const file = new DbFile('lite-test-sidecars');
  const db = file.connect(lc);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');

  // The connection stays open on purpose. SQLite removes the sidecars on a clean
  // close, so closing first would leave nothing for delete() to remove and the
  // assertion below would hold over an empty set. Asserting one exists first is
  // what makes the second assertion mean something.
  //
  // Only `-wal` is asserted: a write in WAL mode creates it on every platform,
  // whereas `-shm` is absent under exclusive locking, which would make this
  // depend on SQLite's coordination strategy rather than on `delete()`.
  expect(existsSync(`${file.path}-wal`)).toBe(true);

  await file.delete();

  // Only the database itself is attributable to `delete()`: closing the
  // connections — which `delete()` does first, and which the case below covers —
  // is what removes `-wal`. That the removal covers every suffix is pinned by
  // delete-lite-db.test.ts, which writes each one as a fixture; asserting the
  // whole list here would pass even if the list were empty.
  expect(existsSync(file.path)).toBe(false);
  expect(existsSync(`${file.path}-wal`)).toBe(false);
});

test('delete closes a connection the caller left open', async () => {
  const file = new DbFile('lite-test-closes-open');
  const db = file.connect(lc);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');

  // Deliberately not closed by the caller — this is the case that failed on
  // Windows with EPERM, and the reason closing belongs here.
  await file.delete();

  expect(() => db.prepare('SELECT 1')).toThrow(/not open/i);
  expect(existsSync(file.path)).toBe(false);
});

test('delete closes every connection handed out, not just the last', async () => {
  const file = new DbFile('lite-test-closes-all');
  const first = file.connect(lc);
  first.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  const second = file.connect(lc);
  const third = file.connect(lc);

  await file.delete();

  // The structural claim: tracking is per-connection. A fix that only closed
  // the most recent one would pass the previous test and fail this.
  for (const db of [first, second, third]) {
    expect(() => db.prepare('SELECT 1')).toThrow(/not open/i);
  }
  expect(existsSync(file.path)).toBe(false);
});

test('delete tolerates a caller that already closed its own connection', async () => {
  const file = new DbFile('lite-test-double-close');
  const db = file.connect(lc);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  db.close();

  await expect(file.delete()).resolves.toBeUndefined();
  expect(existsSync(file.path)).toBe(false);
});

test('delete reports a file the OS still holds rather than failing the test', async () => {
  // A replica under os.tmpdir() that Windows has not let go of yet is housekeeping,
  // not the behaviour under test. Measured there: a file no surviving process
  // holds, that no deadline short enough for a 30s hook outlasts, and that deletes
  // without complaint a minute later. Throwing reports "replication is broken"
  // about a filesystem that is merely slow.
  const file = new DbFile('lite-test-held-open');
  const db = file.connect(lc);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');

  const held = vi
    .spyOn(deleteLiteDb, 'deleteLiteDBAsync')
    .mockRejectedValue(
      Object.assign(new Error(`EBUSY: ${file.path}`), {code: 'EBUSY'}),
    );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await expect(file.delete()).resolves.toBeUndefined();
    // Said out loud, so a file left behind is visible rather than silent.
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain(file.path);
  } finally {
    held.mockRestore();
    warn.mockRestore();
  }
  // The connection it handed out is closed either way, so nothing is left open.
  expect(() => db.close()).not.toThrow();
});

test('delete is idempotent and does not re-close stale connections', async () => {
  const file = new DbFile('lite-test-idempotent');
  seed(file);

  await file.delete();
  // The tracked set is drained on the first call, so a second delete has
  // nothing to close and no file to remove.
  await expect(file.delete()).resolves.toBeUndefined();
  expect(existsSync(file.path)).toBe(false);
});

test('a connection opened after delete is tracked by the next delete', async () => {
  const file = new DbFile('lite-test-reopen');
  seed(file);
  await file.delete();

  const reopened = file.connect(lc);
  reopened.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  await file.delete();

  expect(() => reopened.prepare('SELECT 1')).toThrow(/not open/i);
  expect(existsSync(file.path)).toBe(false);
});
