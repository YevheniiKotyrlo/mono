import {rmSync} from 'node:fs';

/** The main database file plus the sidecars SQLite may have created. */
export const LITE_DB_SUFFIXES = ['', '-wal', '-wal2', '-shm'] as const;

/**
 * How to remove one replica file, per platform.
 *
 * POSIX unlinks a file that still has open handles, so it needs no retries and
 * must not have any: the retry set includes EPERM, ENOTEMPTY, EMFILE and ENFILE,
 * all of which occur legitimately there (read-only mount, wrong owner, fd
 * exhaustion) and none of which a delay can fix — `rmSync` is synchronous, so
 * nothing can close an fd while it sleeps. Retrying would only convert a fast,
 * accurate failure into a blocked event loop.
 *
 * Windows refuses to unlink a file with an open handle, and SQLite unmaps
 * lazily, so the file can stay busy for a moment after `close()`. There the
 * retries earn their keep, with a budget small enough to stay a hiccup: the
 * backoff is linear, so 5 retries at 20ms is ~300ms worst case rather than the
 * ~2.75s that 10 at 50ms would cost — per suffix.
 *
 * `recursive` is set because Node documents `maxRetries`/`retryDelay` as ignored
 * without it. The current implementation honours them either way, but relying on
 * that would be relying on undocumented behaviour.
 */
export function liteDbRemoveOptions(platform: string = process.platform) {
  const retry = platform === 'win32';
  return {
    force: true,
    // Only meaningful alongside the retry budget, per Node's documentation.
    recursive: retry,
    maxRetries: retry ? 5 : 0,
    retryDelay: retry ? 20 : 0,
  };
}

export function deleteLiteDB(dbFile: string) {
  const options = liteDbRemoveOptions();
  for (const suffix of LITE_DB_SUFFIXES) {
    rmSync(`${dbFile}${suffix}`, options);
  }
}
