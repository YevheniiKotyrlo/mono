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
  liteDbRemoveOptions,
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

// The retry budget is platform-dependent and the platform is a parameter, so
// both shapes are asserted on every runner. POSIX must NOT retry: EPERM,
// ENOTEMPTY, EMFILE and ENFILE all occur there legitimately and no delay can fix
// them, so retrying would only turn a fast accurate failure into a stall.
test('does not retry on posix, where unlink-while-open already works', () => {
  const options = liteDbRemoveOptions('linux');
  expect(options.force).toBe(true);
  expect(options.maxRetries).toBe(0);
});

test('retries on win32, where an open handle blocks the unlink', () => {
  const options = liteDbRemoveOptions('win32');
  expect(options.maxRetries).toBeGreaterThan(0);
  expect(options.retryDelay).toBeGreaterThan(0);
  // Linear backoff: keep the worst case a hiccup rather than seconds per file.
  const worstCaseMs =
    ((options.maxRetries * (options.maxRetries + 1)) / 2) * options.retryDelay;
  expect(worstCaseMs).toBeLessThan(500);
  // Documented behaviour: Node ignores the retry options without `recursive`.
  expect(options.recursive).toBe(true);
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
  const remaining = LITE_DB_SUFFIXES.filter(suffix =>
    existsSync(`${dbFile}${suffix}`),
  );
  expect(remaining).toEqual([]);
});
