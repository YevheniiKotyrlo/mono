import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {LogContext} from '@rocicorp/logger';
import {expect} from 'vitest';
import {randInt} from '../../../shared/src/rand.ts';
import {Database} from '../../../zqlite/src/db.ts';
import {deleteLiteDB} from '../db/delete-lite-db.ts';
import {id} from '../types/sql.ts';

export class DbFile {
  readonly path;
  readonly #connections: Database[] = [];

  constructor(testName: string) {
    // join, not string concatenation: concatenating gave a mixed-separator path
    // like `C:\Users\…\Temp/name-123.db`, which works but leaks into failure
    // messages and any path comparison.
    this.path = join(tmpdir(), `${testName}-${randInt(1000000, 9999999)}.db`);
  }

  connect(lc: LogContext): Database {
    const db = new Database(lc, this.path);
    this.#connections.push(db);
    return db;
  }

  /**
   * Closes the connections this file handed out, then removes it.
   *
   * The close is load-bearing on Windows, which refuses to unlink a file that
   * still has an open handle (EPERM/EBUSY). POSIX allows unlink-while-open, so
   * a `delete()` that left connections open worked there and failed here —
   * which is why the file that hands out the connections is what closes them,
   * rather than asking every test to remember.
   */
  delete() {
    for (const db of this.#connections.splice(0)) {
      try {
        db.close();
      } catch {
        // Tests are free to close their own connection first; closing twice is
        // not an error worth failing teardown over.
      }
    }
    deleteLiteDB(this.path);
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
