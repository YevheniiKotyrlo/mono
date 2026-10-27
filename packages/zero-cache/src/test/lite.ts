import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import type {LogContext} from '@rocicorp/logger';
import {expect} from 'vitest';
import {randInt} from '../../../shared/src/rand.ts';
import {sleep} from '../../../shared/src/sleep.ts';
import {Database} from '../../../zqlite/src/db.ts';
import {SQLITE_FILE_SUFFIXES} from '../db/delete-lite-db.ts';
import {id} from '../types/sql.ts';

/** How long {@link DbFile.delete} retries a file Windows still holds. */
export const REMOVE_DEADLINE_MS = 2_000;
const REMOVE_RETRY_DELAY_MS = 50;

export type FileRemoval = {
  readonly platform: NodeJS.Platform;
  readonly now: () => number;
  readonly wait: (ms: number) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
};

const SYSTEM_FILE_REMOVAL: FileRemoval = {
  platform: process.platform,
  now: Date.now,
  wait: sleep,
  remove: path => rm(path, {force: true}),
};

export class DbFile {
  readonly path;
  readonly #removal: FileRemoval;
  readonly #connections: Database[] = [];

  constructor(testName: string, removal: FileRemoval = SYSTEM_FILE_REMOVAL) {
    this.path = `${tmpdir()}/${testName}-${randInt(1000000, 9999999)}.db`;
    this.#removal = removal;
  }

  connect(lc: LogContext): Database {
    const db = new Database(lc, this.path);
    this.#connections.push(db);
    return db;
  }

  /**
   * Closes the connections this file handed out, then removes it and its
   * sidecars. Windows refuses to unlink a file with an open handle, so a
   * refused removal is retried there until {@link REMOVE_DEADLINE_MS}: a
   * handle a worker thread of this process holds is released only once the
   * event loop runs its teardown, which a blocking retry would starve.
   */
  async delete(): Promise<void> {
    for (const db of this.#connections.splice(0)) {
      db.close();
    }
    await removeDatabaseFiles(this.path, this.#removal);
  }
}

async function removeDatabaseFiles(
  path: string,
  removal: FileRemoval,
): Promise<void> {
  const deadline = removal.now() + REMOVE_DEADLINE_MS;
  let remaining: readonly string[] = SQLITE_FILE_SUFFIXES.map(
    suffix => `${path}${suffix}`,
  );
  for (;;) {
    const held: string[] = [];
    const failures: unknown[] = [];
    for (const file of remaining) {
      try {
        await removal.remove(file);
      } catch (e) {
        held.push(file);
        failures.push(e);
      }
    }
    if (held.length === 0) {
      return;
    }
    if (removal.platform !== 'win32' || removal.now() >= deadline) {
      throw new AggregateError(failures, `Could not remove ${held.join(', ')}`);
    }
    remaining = held;
    await removal.wait(REMOVE_RETRY_DELAY_MS);
  }
}

export function initDB(
  db: Database,
  statements?: string,
  tables?: Record<string, object[]>,
) {
  db.transaction(() => {
    if (statements) {
      db.exec(statements);
    }
    for (const [name, rows] of Object.entries(tables ?? {})) {
      const columns = Object.keys(rows[0]);
      const cols = columns.map(c => id(c)).join(',');
      const vals = Array.from({length: columns.length}).fill('?').join(',');
      const insertStmt = db.prepare(
        `INSERT INTO ${id(name)} (${cols}) VALUES (${vals})`,
      );
      for (const row of rows) {
        insertStmt.run(Object.values(row));
      }
    }
  });
}

export function expectTableExact(
  db: Database,
  table: string,
  expectedRows: unknown[],
  numberType: 'number' | 'bigint' = 'number',
  ...orderBy: string[]
) {
  const ordering = orderBy.map(c => id(c)).join(', ');
  const actual = db
    .prepare(`SELECT * FROM ${id(table)} ORDER BY ${ordering}`)
    .safeIntegers(numberType === 'bigint')
    .all();
  expect(actual).toEqual(expectedRows);
}

export function expectTables(
  db: Database,
  tables?: Record<string, unknown[]>,
  numberType: 'number' | 'bigint' = 'number',
) {
  for (const [table, expected] of Object.entries(tables ?? {})) {
    const actual = db
      .prepare(`SELECT * FROM ${id(table)}`)
      .safeIntegers(numberType === 'bigint')
      .all();
    expect(actual).toEqual(expect.arrayContaining(expected));
    expect(expected).toEqual(expect.arrayContaining(actual));
  }
}

export function expectMatchingObjectsInTables(
  db: Database,
  tables?: Record<string, unknown[]>,
  numberType: 'number' | 'bigint' = 'number',
) {
  for (const [table, expected] of Object.entries(tables ?? {})) {
    const actual = db
      .prepare(`SELECT * FROM ${id(table)}`)
      .safeIntegers(numberType === 'bigint')
      .all();
    expect(actual).toMatchObject(expected);
  }
}
