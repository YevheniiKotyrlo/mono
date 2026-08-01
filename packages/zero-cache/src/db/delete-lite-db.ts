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
 * How to remove one replica file.
 *
 * No retries, on any platform, and the awaited version below is why. POSIX unlinks
 * a file that still has open handles, so it never needs one. Windows refuses, but
 * `rm`'s retries BLOCK — and the release they are waiting for is work on the event
 * loop, so they starve exactly what they need and expire against a file nothing is
 * free to unlock. Retrying is worth doing only where the loop keeps running, which
 * is one place, and it owns its own loop.
 *
 * That leaves `force` alone: ignore a file that is already gone, and let anything
 * else be reported. `recursive` is deliberately absent — it was only ever here
 * because Node documents `maxRetries` as ignored without it, and it would turn a
 * misconfigured directory path into a silent tree delete instead of the kernel's
 * own refusal.
 */
const REMOVE_OPTIONS: RmOptions = {force: true};

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
  // Injected so the all-attempted behaviour is observable. A removal failure
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
      remove(path, REMOVE_OPTIONS);
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
        await remove(path, REMOVE_OPTIONS);
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
  // would report less than the single errno this used to throw.
  throw new AggregateError(
    failures,
    `Could not remove every file of ${dbFile} (${failures.length} of ` +
      `${attempted} failed): ${first instanceof Error ? first.message : String(first)}`,
    {cause: first},
  );
}
