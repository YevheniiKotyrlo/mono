import type {LogContext} from '@rocicorp/logger';
import type {Database} from '../../../../../zqlite/src/db.ts';

/**
 * The replicator alone gathers the replica's query planner statistics, under
 * its connection's `analysis_limit` (`replica.analysisLimit`): when it prepares
 * the replica, and after a replicated schema change. Every other connection
 * to the replica either opens it read-only or closes it with
 * `{optimize: false}`, so that nothing gathers statistics under another limit.
 */

// analysisLimit : The `analysis_limit` under which the replicator last
//                 gathered the statistics of every table.
// lock          : Auto-magic column for enforcing single-row semantics.
export const CREATE_STATISTICS_TABLE = /*sql*/ `
  CREATE TABLE "_zero.statistics" (
    analysisLimit INTEGER NOT NULL,
    lock INTEGER PRIMARY KEY DEFAULT 1 CHECK (lock=1)
  );
`;

/**
 * The `PRAGMA optimize` mask the replicator gathers statistics with: SQLite's
 * default mask without 0x10, with which SQLite would replace an
 * `analysis_limit` of 0, or of 2000 and above, with a temporary 2000.
 *
 * https://sqlite.org/pragma.html#pragma_optimize
 */
const OPTIMIZE_MASK = 0xfffe & ~0x10;

/** Checks every table, rather than only those the connection has queried. */
const OPTIMIZE_ALL_TABLES = 0x10000;

/**
 * Gathers the replica's statistics under the connection's `analysis_limit`:
 * those of every table when the replica records none, or records another
 * limit, and otherwise those of each table that SQLite finds without
 * statistics or ten times larger or smaller than when they were gathered.
 */
export function gatherStatistics(lc: LogContext, db: Database): void {
  const start = performance.now();
  const [{analysis_limit: analysisLimit}] = db.pragma<{
    analysis_limit: number;
  }>('analysis_limit');
  const recorded = db
    .prepare(`SELECT analysisLimit FROM "_zero.statistics"`)
    .get<{analysisLimit: number} | undefined>();

  if (recorded?.analysisLimit === analysisLimit) {
    db.pragma(`optimize = ${OPTIMIZE_ALL_TABLES | OPTIMIZE_MASK}`);
    lc.info?.(
      `optimized ${db.name} (${(performance.now() - start).toFixed(2)} ms)`,
    );
    return;
  }

  db.transaction(() => {
    db.exec('ANALYZE main');
    db.prepare(
      `INSERT OR REPLACE INTO "_zero.statistics" (analysisLimit, lock) VALUES (?, 1)`,
    ).run(analysisLimit);
  });
  lc.info?.(
    `analyzed every table of ${db.name} under analysis_limit ${analysisLimit}, ` +
      `where it recorded ${recorded?.analysisLimit ?? 'none'} ` +
      `(${(performance.now() - start).toFixed(2)} ms)`,
  );
}

/**
 * Gathers, under the connection's `analysis_limit`, the statistics of each
 * table that SQLite finds without statistics, as an index a schema change
 * created leaves its table, or that the connection has queried and finds ten
 * times larger or smaller than when its statistics were gathered.
 */
export function optimizeStatistics(db: Database): void {
  db.pragma(`optimize = ${OPTIMIZE_MASK}`);
}
