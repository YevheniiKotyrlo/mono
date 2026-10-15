/**
 * Every file a SQLite database can consist of: the database itself plus each
 * sidecar any journal mode may have left beside it.
 *
 * `-journal` belongs here even where a database runs in WAL or WAL2: a rollback
 * journal is what the default journal mode leaves, so any code path that writes
 * before switching modes, or is interrupted while doing so, can leave one behind.
 *
 * It lives in shared because it is a fact about SQLite's on-disk layout rather
 * than about deleting or diagnosing a database.
 */
export const SQLITE_FILE_SUFFIXES = [
  '',
  '-wal',
  '-wal2',
  '-shm',
  '-journal',
] as const;
