import {rmSync, statSync, type RmOptions} from 'node:fs';
import {SQLITE_FILE_SUFFIXES} from '../../../shared/src/sqlite-file-suffixes.ts';

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
 * Windows refuses to unlink a file with an open handle, and SQLite unmaps lazily,
 * so the file can stay busy for a moment after `close()`. There the retries earn
 * their keep, with a budget small enough to stay a hiccup: the backoff is linear,
 * so 5 retries at 20ms is ~300ms worst case per file.
 *
 * `recursive` rides with the retry budget, because Node documents
 * `maxRetries`/`retryDelay` as ignored without it — and only there. It also turns
 * a removal into a tree delete, so where no retries are wanted it buys nothing and
 * costs the kernel's own `EISDIR` refusal. The caller below refuses a directory on
 * every platform regardless; this keeps the kernel as a second line where it can.
 */
function removeOptions(platform: NodeJS.Platform): RmOptions {
  const retry = platform === 'win32';
  return {
    force: true,
    recursive: retry,
    maxRetries: retry ? 5 : 0,
    retryDelay: retry ? 20 : 0,
  };
}

/**
 * Throws unless `path` is a file or absent.
 *
 * These paths come from operator config, so a directory is reachable by
 * misconfiguration — and the removal options are recursive, which would make that
 * a silent tree delete where it used to be a loud EISDIR.
 */
function assertNotADirectory(path: string): void {
  if (statSync(path, {throwIfNoEntry: false})?.isDirectory()) {
    throw new Error(
      `Refusing to delete ${path}: it is a directory, not a SQLite database file.`,
    );
  }
}

/**
 * Removes a SQLite database and every file that can belong to it.
 *
 * Every path is checked before any is removed, so a rejected path cannot leave the
 * database half-deleted — the callers here recreate it immediately, and a surviving
 * sidecar would then be recovered into a freshly created file. Removal failures are
 * collected for the same reason: all five are attempted, then reported together.
 */
export function deleteLiteDB(
  dbFile: string,
  platform: NodeJS.Platform = process.platform,
  // Injected so both the per-platform options and the all-attempted behaviour are
  // observable. A removal failure cannot be provoked portably through the
  // filesystem — the one fixture that can be built is a directory, which the guard
  // above rejects first — so without this seam the aggregate path has no test that
  // could fail.
  remove: (path: string, options: RmOptions) => void = rmSync,
) {
  const paths = SQLITE_FILE_SUFFIXES.map(suffix => `${dbFile}${suffix}`);
  for (const path of paths) {
    assertNotADirectory(path);
  }

  const options = removeOptions(platform);
  const failures: unknown[] = [];
  for (const path of paths) {
    try {
      remove(path, options);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    const [first] = failures;
    // The first failure's text is folded into the message and kept as the cause:
    // an AggregateError's own message says nothing, so a sink that stringifies it
    // would report less than the single errno this used to throw.
    throw new AggregateError(
      failures,
      `Could not remove every file of ${dbFile} (${failures.length} of ` +
        `${paths.length} failed): ${first instanceof Error ? first.message : String(first)}`,
      {cause: first},
    );
  }
}
