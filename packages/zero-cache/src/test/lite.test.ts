import {existsSync} from 'node:fs';
import {expect, test} from 'vitest';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {DbFile, REMOVE_DEADLINE_MS, type FileRemoval} from './lite.ts';

const lc = createSilentLogContext();

function seed(file: DbFile): void {
  const db = file.connect(lc);
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  db.close();
}

function isClosed(db: ReturnType<DbFile['connect']>): boolean {
  try {
    db.prepare('SELECT 1');
    return false;
  } catch {
    return true;
  }
}

/**
 * A removal whose clock and waits are the test's, refusing the database file
 * the first `refusals` times it is asked to remove it.
 */
function removalRefusing(
  platform: NodeJS.Platform,
  refusals: number,
): FileRemoval & {readonly attempts: () => number} {
  let now = 0;
  let attempts = 0;
  return {
    platform,
    now: () => now,
    wait: ms => {
      now += ms;
      return Promise.resolve();
    },
    remove: path => {
      if (!path.endsWith('.db')) {
        return Promise.resolve();
      }
      attempts++;
      return attempts <= refusals
        ? Promise.reject(
            Object.assign(new Error(`EBUSY: ${path}`), {code: 'EBUSY'}),
          )
        : Promise.resolve();
    },
    attempts: () => attempts,
  };
}

test('delete removes the database and the sidecars an open connection keeps', async () => {
  const file = new DbFile('lite-test-sidecars');
  const db = file.connect(lc);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  expect(existsSync(`${file.path}-wal`)).toBe(true);

  await file.delete();

  expect(existsSync(file.path)).toBe(false);
  expect(existsSync(`${file.path}-wal`)).toBe(false);
});

test('delete closes every connection handed out, including ones the caller left open', async () => {
  const file = new DbFile('lite-test-closes-all');
  const first = file.connect(lc);
  first.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  const second = file.connect(lc);
  const third = file.connect(lc);

  await file.delete();

  expect([first, second, third].map(isClosed)).toEqual([true, true, true]);
  expect(existsSync(file.path)).toBe(false);
});

test('delete leaves alone a connection the caller already closed', async () => {
  const file = new DbFile('lite-test-closed-first');
  seed(file);

  await file.delete();

  expect(existsSync(file.path)).toBe(false);
});

test('a connection opened after delete is closed by the next delete', async () => {
  const file = new DbFile('lite-test-reopen');
  seed(file);
  await file.delete();

  const reopened = file.connect(lc);
  reopened.exec('CREATE TABLE t (a INTEGER PRIMARY KEY)');
  await file.delete();

  expect(isClosed(reopened)).toBe(true);
  expect(existsSync(file.path)).toBe(false);
});

test('on Windows a refused removal is retried until the file goes', async () => {
  const removal = removalRefusing('win32', 3);
  const file = new DbFile('lite-test-retried', removal);

  await file.delete();

  expect(removal.attempts()).toBe(4);
});

test('on Windows a file still held at the deadline fails the delete, naming it', async () => {
  const removal = removalRefusing('win32', Number.POSITIVE_INFINITY);
  const file = new DbFile('lite-test-held', removal);

  await expect(file.delete()).rejects.toThrow(`Could not remove ${file.path}`);
  expect(removal.now()).toBeGreaterThanOrEqual(REMOVE_DEADLINE_MS);
});

test('elsewhere a refused removal fails at once', async () => {
  const removal = removalRefusing('linux', 1);
  const file = new DbFile('lite-test-not-retried', removal);

  await expect(file.delete()).rejects.toThrow(`Could not remove ${file.path}`);
  expect(removal.attempts()).toBe(1);
});
