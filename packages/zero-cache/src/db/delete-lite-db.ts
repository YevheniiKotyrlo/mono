import {rmSync} from 'node:fs';

/** The database file and every sidecar SQLite can leave beside it. */
export const SQLITE_FILE_SUFFIXES = [
  '',
  '-wal',
  '-wal2',
  '-shm',
  '-journal',
] as const;

export function deleteLiteDB(dbFile: string) {
  for (const suffix of SQLITE_FILE_SUFFIXES) {
    rmSync(`${dbFile}${suffix}`, {force: true});
  }
}
