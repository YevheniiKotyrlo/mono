import {rmSync} from 'node:fs';

/** The main database file plus the sidecars SQLite may have created. */
export const LITE_DB_SUFFIXES = ['', '-wal', '-wal2', '-shm'] as const;

/**
 * POSIX lets you unlink a file that still has open handles; Windows does not,
 * and fails with EPERM or EBUSY instead. `force` suppresses ENOENT but not
 * those, so a replica whose handle the OS has not released yet — SQLite unmaps
 * lazily, so this happens even after close() — made deletion throw.
 *
 * maxRetries is exactly what Node documents for this case: it retries on EBUSY,
 * EMFILE, ENFILE, ENOTEMPTY and EPERM with a linear backoff. Retrying is the
 * whole fix — the handle is already closed by the time we get here, Windows
 * just has not caught up.
 */
export const LITE_DB_REMOVE_OPTIONS = {
  force: true,
  maxRetries: 10,
  retryDelay: 50,
} as const;

export function deleteLiteDB(dbFile: string) {
  for (const suffix of LITE_DB_SUFFIXES) {
    rmSync(`${dbFile}${suffix}`, LITE_DB_REMOVE_OPTIONS);
  }
}
