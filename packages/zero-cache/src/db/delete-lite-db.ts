import {rmSync, statSync, type RmOptions} from 'node:fs';
import {rm} from 'node:fs/promises';
import {sleep} from '../../../shared/src/sleep.ts';
import {SQLITE_FILE_SUFFIXES} from '../../../shared/src/sqlite-file-suffixes.ts';

/**
 * How long the awaited removal keeps trying before reporting what is still held.
 *
 * One deadline for the database rather than a budget per file: `rm`'s own
 * `maxRetries` is per call, so five sidecars multiply it, and a wait long enough
 * for the last file stops fitting inside the timeout of whatever is waiting. What
 * a caller wants to bound is how long until the database is gone.
 */
export const ASYNC_REMOVE_DEADLINE_MS = 8_000;
const ASYNC_REMOVE_RETRY_DELAY_MS = 50;

/**
 * How to remove one replica file, per platform and per caller.
 *
 * The two retry policies here are not layers over the same problem, which is why
 * both earn their place. They cover different holders:
 *
 * - The blocking budget covers a handle THIS process just closed. Windows releases
 *   one a moment after the close, at the kernel's pace and without needing the
 *   event loop, so a short blocking wait is exactly the right instrument.
 *   Measured: removing it turned 20 pg suites red on Windows.
 * - The awaited loop below covers a handle ANOTHER process is dropping as it
 *   exits. That release IS event-loop work here, so blocking would starve it —
 *   which is why that path takes no budget from `rm` and owns its own.
 *
 * POSIX needs neither: unlink-while-open is legal, and the retry set includes
 * EPERM, ENOTEMPTY, EMFILE and ENFILE, all of which occur there legitimately and
 * none of which a delay can fix.
 *
 * `recursive` rides with the blocking budget because Node documents
 * `maxRetries`/`retryDelay` as ignored without it. It also turns a removal into a
 * tree delete, so where nothing is retried it buys nothing and costs the kernel's
 * own refusal to unlink a directory — hence the guard below, which refuses one on
 * every platform first.
 */
const SYNC_RETRY_BUDGET = {maxRetries: 5, retryDelay: 20} as const;

function removeOptions(platform: NodeJS.Platform, retries: boolean): RmOptions {
  const retry = retries && platform === 'win32';
  return {
    force: true,
    recursive: retry,
    maxRetries: retry ? SYNC_RETRY_BUDGET.maxRetries : 0,
    retryDelay: retry ? SYNC_RETRY_BUDGET.retryDelay : 0,
  };
}

/**
 * Throws unless `path` is a file or absent.
 *
 * These paths come from operator config, so a directory is reachable by
 * misconfiguration. The kernel refuses to unlink one anyway, but its error names
 * the path rather than the mistake, and a caller reading `EISDIR` from a replica
 * removal has to work out why a directory was there at all.
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
  // observable. A removal failure
  // cannot be provoked portably through the filesystem — the one fixture that can
  // be built is a directory, which the guard above rejects first — so without this
  // seam the aggregate path has no test that could fail.
  remove: (path: string, options: RmOptions) => void = rmSync,
) {
  const paths = SQLITE_FILE_SUFFIXES.map(suffix => `${dbFile}${suffix}`);
  for (const path of paths) {
    assertNotADirectory(path);
  }

  const failures: unknown[] = [];
  for (const path of paths) {
    try {
      remove(path, removeOptions(platform, true));
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

  // One deadline for the database, not one budget per file. `rm`'s own
  // `maxRetries` is per call, so five sidecars multiply it — a budget generous
  // enough for the last file to be released becomes five times that in the worst
  // case, which is how a wait long enough to work stops fitting inside the timeout
  // of whatever is waiting for it. What a caller wants to bound is how long until
  // the database is gone.
  const deadline = Date.now() + ASYNC_REMOVE_DEADLINE_MS;
  let remaining = paths;
  const failures: unknown[] = [];

  for (;;) {
    const stillHeld: string[] = [];
    failures.length = 0;
    for (const path of remaining) {
      try {
        await remove(path, removeOptions(platform, false));
      } catch (error) {
        // Only the paths still held are retried, so one that has already gone
        // cannot contribute a failure on a later pass.
        stillHeld.push(path);
        failures.push(error);
      }
    }
    remaining = stillHeld;
    if (remaining.length === 0 || Date.now() >= deadline) {
      break;
    }
    await sleep(ASYNC_REMOVE_RETRY_DELAY_MS);
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
  // would report less than a single errno does.
  throw new AggregateError(
    failures,
    `Could not remove every file of ${dbFile} (${failures.length} of ` +
      `${attempted} failed): ${first instanceof Error ? first.message : String(first)}`,
    {cause: first},
  );
}
