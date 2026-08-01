import {rmSync, statSync, type RmOptions} from 'node:fs';
import {rm} from 'node:fs/promises';
import {SQLITE_FILE_SUFFIXES} from '../../../shared/src/sqlite-file-suffixes.ts';

/**
 * Small on purpose: every attempt blocks, so this is a hiccup budget, not a wait.
 * The backoff is linear, making 5 tries at 20ms about 300ms worst case per file.
 */
export const SYNC_RETRY_BUDGET = {maxRetries: 5, retryDelay: 20} as const;

/**
 * Larger than the synchronous budget because it costs no blocking — the loop keeps
 * running between attempts, so the handle can actually be released while they
 * elapse, and the observed case succeeds on the second attempt.
 *
 * Still bounded well under a test hook's timeout, deliberately. A handle held by a
 * process that is never going to release it does not become releasable with more
 * waiting, and a budget long enough to outlast the hook turns a precise `EPERM`
 * naming the file into `Hook timed out`, which names nothing. 10 tries on a linear
 * backoff is ~2.8s worst case.
 */
export const ASYNC_RETRY_BUDGET = {maxRetries: 10, retryDelay: 50} as const;

/**
 * How to remove one replica file, per platform.
 *
 * POSIX unlinks a file that still has open handles, so it needs no retries and
 * must not have any: the retry set includes EPERM, ENOTEMPTY, EMFILE and ENFILE,
 * all of which occur legitimately there (read-only mount, wrong owner, fd
 * exhaustion) and none of which a delay can fix. Retrying would only convert a
 * fast, accurate failure into a wait.
 *
 * Windows refuses to unlink a file with an open handle, and SQLite unmaps lazily,
 * so the file can stay busy for a moment after `close()`. There the retries earn
 * their keep — how much is worth spending on them is the caller's, since it
 * depends on whether waiting blocks the release; see the two budgets above.
 *
 * `recursive` rides with the retry budget, because Node documents
 * `maxRetries`/`retryDelay` as ignored without it — and only there. It also turns
 * a removal into a tree delete, so where no retries are wanted it buys nothing and
 * costs the kernel's own `EISDIR` refusal. The callers below refuse a directory on
 * every platform regardless; this keeps the kernel as a second line where it can.
 */
function removeOptions(
  platform: NodeJS.Platform,
  budget: {maxRetries: number; retryDelay: number} = SYNC_RETRY_BUDGET,
): RmOptions {
  const retry = platform === 'win32';
  return {
    force: true,
    recursive: retry,
    maxRetries: retry ? budget.maxRetries : 0,
    retryDelay: retry ? budget.retryDelay : 0,
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
  reportFailures(dbFile, failures, paths.length);
}

/**
 * The same removal, awaited.
 *
 * Retrying a Windows unlink only works if the event loop can run between
 * attempts. `rmSync`'s own `maxRetries` cannot: it blocks, so the release the
 * retries are waiting for is exactly the work being starved — a handle a
 * departing process is about to drop stays held for as long as the loop is
 * blocked, and the retries expire against a file nothing is going to free.
 * Measured on a Windows checkout: a replica file that a synchronous loop still
 * could not remove after 30 seconds and 600 attempts is removed on the second
 * asynchronous one.
 *
 * So callers that can await should, and the ones that cannot keep the
 * synchronous version above — which is every production caller here, all of
 * which delete a replica at startup or restore, where no handle in this process
 * is outstanding. The tests are the opposite case: they have just killed the
 * processes that held the file.
 */
export async function deleteLiteDBAsync(
  dbFile: string,
  platform: NodeJS.Platform = process.platform,
  // Injected for the same reason as above.
  remove: (path: string, options: RmOptions) => Promise<void> = rm,
): Promise<void> {
  const paths = SQLITE_FILE_SUFFIXES.map(suffix => `${dbFile}${suffix}`);
  for (const path of paths) {
    assertNotADirectory(path);
  }

  const options = removeOptions(platform, ASYNC_RETRY_BUDGET);
  const failures: unknown[] = [];
  for (const path of paths) {
    try {
      await remove(path, options);
    } catch (error) {
      failures.push(error);
    }
  }
  reportFailures(dbFile, failures, paths.length);
}

function reportFailures(
  dbFile: string,
  failures: readonly unknown[],
  attempted: number,
): void {
  if (failures.length === 0) {
    return;
  }
  const [first] = failures;
  // The first failure's text is folded into the message and kept as the cause:
  // an AggregateError's own message says nothing, so a sink that stringifies it
  // would report less than the single errno this used to throw.
  throw new AggregateError(
    failures,
    `Could not remove every file of ${dbFile} (${failures.length} of ` +
      `${attempted} failed): ${first instanceof Error ? first.message : String(first)}`,
    {cause: first},
  );
}
