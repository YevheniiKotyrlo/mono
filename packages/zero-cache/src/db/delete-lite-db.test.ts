import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect, test} from 'vitest';
import {
  deleteLiteDB,
  LITE_DB_REMOVE_OPTIONS,
  LITE_DB_SUFFIXES,
} from './delete-lite-db.ts';

function makeDbWithSidecars(): string {
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  const dbFile = join(dir, 'replica.db');
  for (const suffix of LITE_DB_SUFFIXES) {
    writeFileSync(`${dbFile}${suffix}`, '');
  }
  return dbFile;
}

test('deletes the database and every sidecar', () => {
  const dbFile = makeDbWithSidecars();
  deleteLiteDB(dbFile);
  const remaining = LITE_DB_SUFFIXES.filter(suffix =>
    existsSync(`${dbFile}${suffix}`),
  );
  expect(remaining).toEqual([]);
});

test('is a no-op when nothing is there', () => {
  const dir = mkdtempSync(join(tmpdir(), 'delete-lite-db-'));
  expect(() => deleteLiteDB(join(dir, 'absent.db'))).not.toThrow();
});

// Windows refuses to unlink a file with an open handle (EPERM/EBUSY) where POSIX
// allows it, so deletion has to retry rather than give up. Pinning the options
// keeps that explicit: dropping maxRetries reintroduces the failure, and it is
// invisible on POSIX where the first attempt always succeeds.
test('retries on the Windows locked-file errors rather than failing', () => {
  expect(LITE_DB_REMOVE_OPTIONS.maxRetries).toBeGreaterThan(0);
  expect(LITE_DB_REMOVE_OPTIONS.retryDelay).toBeGreaterThan(0);
  expect(LITE_DB_REMOVE_OPTIONS.force).toBe(true);
});

test('succeeds even while a handle on the file is open', () => {
  const dbFile = makeDbWithSidecars();
  // On Windows this is the exact condition that used to throw EPERM; on POSIX
  // it passes trivially, which is why the assertion above pins the options too.
  const handle = openSync(dbFile, 'r');
  try {
    deleteLiteDB(dbFile);
  } finally {
    closeSync(handle);
  }
  for (const suffix of LITE_DB_SUFFIXES) {
    if (suffix === '') continue;
    expect(existsSync(`${dbFile}${suffix}`)).toBe(false);
  }
});
