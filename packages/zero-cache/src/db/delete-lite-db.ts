import {rmSync, statSync, type RmOptions} from 'node:fs';

/**
 * Every file a SQLite database can consist of: the database itself plus each
 * sidecar any journal mode may have left beside it.
 *
 * `-journal` belongs here even though the replica runs in WAL2: `prepare()`
 * switches to `journal_mode = delete` and the version-history write in
 * `migration-lite.ts` runs at the connection default, so an interrupted run can
 * leave a rollback journal beside a database that the next start overwrites.
 */
export const SQLITE_FILE_SUFFIXES = [
  '',
  '-wal',
  '-wal2',
  '-shm',
  '-journal',
] as const;

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
 * `recursive` is on because Node documents `maxRetries`/`retryDelay` as ignored
 * without it. It is not a licence to remove a tree: it also decides what happens
 * when the path names a directory, and these paths come from operator config, so
 * `deleteLiteDB` refuses a directory before ever reaching here. Without that
 * guard this would turn a misconfigured replica path from a loud `EISDIR` into a
 * silent recursive delete.
 */
export function liteDbRemoveOptions(platform: NodeJS.Platform) {
  const retry = platform === 'win32';
  return {
    force: true,
    recursive: true,
    maxRetries: retry ? 5 : 0,
    retryDelay: retry ? 20 : 0,
  } satisfies RmOptions;
}

export function deleteLiteDB(dbFile: string) {
  const options = liteDbRemoveOptions(process.platform);
  const failures: unknown[] = [];
  for (const suffix of SQLITE_FILE_SUFFIXES) {
    const path = `${dbFile}${suffix}`;
    if (statSync(path, {throwIfNoEntry: false})?.isDirectory()) {
      throw new Error(
        `Refusing to delete ${path}: it is a directory, not a SQLite database file.`,
      );
    }
    try {
      rmSync(path, options);
    } catch (error) {
      // Every suffix is attempted before reporting. Stopping at the first failure
      // leaves some files removed and others not, and the callers here recreate
      // the database immediately — so a surviving sidecar would be recovered into
      // a freshly created file.
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Could not remove every file of ${dbFile}`,
    );
  }
}
