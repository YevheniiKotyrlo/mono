/**
 * Every file a SQLite database can consist of: the database itself plus each
 * sidecar any journal mode may have left beside it.
 *
 * `-journal` belongs here even where a database runs in WAL or WAL2 — a rollback
 * journal is what the default journal mode leaves, so any code path that writes
 * before switching modes, or is interrupted while doing so, can leave one behind.
 *
 * It lives here rather than beside any one consumer because it is a fact about
 * SQLite's on-disk layout, not about deleting, diagnosing, or benchmarking. Three
 * packages need it and each would otherwise keep its own copy — which is how one
 * of them came to be missing `-wal2`, the mode its replica actually runs in.
 */
export const SQLITE_FILE_SUFFIXES = [
  '',
  '-wal',
  '-wal2',
  '-shm',
  '-journal',
] as const;
