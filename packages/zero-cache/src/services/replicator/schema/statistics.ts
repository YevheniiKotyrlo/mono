import type {LogContext} from '@rocicorp/logger';
import type {Database} from '../../../../../zqlite/src/db.ts';

/**
 * The replicator's write worker, the replica's one writer, alone gathers the
 * replica's query planner statistics, under its connection's `analysis_limit`
 * (`replica.analysisLimit`), in its own thread: when it opens the replica, and
 * after a replicated schema change. Every other connection to the replica
 * either opens it read-only or closes it with `{optimize: false}`, so that
 * nothing gathers statistics under another limit.
 */

// analysisLimit : The `analysis_limit` under which the replicator last
//                 gathered the statistics of every table, or NULL for
//                 statistics an earlier zero-cache gathered, which recorded
//                 no limit.
// lock          : Auto-magic column for enforcing single-row semantics.
export const CREATE_STATISTICS_TABLE = /*sql*/ `
  CREATE TABLE "_zero.statistics" (
    analysisLimit INTEGER,
    lock INTEGER PRIMARY KEY DEFAULT 1 CHECK (lock=1)
  );
`;

/**
 * The `analysis_limit` an earlier zero-cache set on the replicator's
 * connections. Statistics it gathered are kept under this limit.
 */
const EARLIER_ANALYSIS_LIMIT = 1000;

/**
 * The `PRAGMA optimize` mask the replicator gathers statistics with: SQLite's
 * default mask without 0x10, with which SQLite would replace an
 * `analysis_limit` of 0, or of 2000 and above, with a temporary 2000, or less
 * when the pass covers more than 100 tables and indexes.
 *
 * https://sqlite.org/pragma.html#pragma_optimize
 */
const OPTIMIZE_MASK = 0xfffe & ~0x10;

/** Checks every table, rather than only those the connection has queried. */
const OPTIMIZE_ALL_TABLES = 0x10000;

/**
 * The `analysis_limit` the replica records its statistics were gathered
 * under: `null` for statistics an earlier zero-cache gathered, and `undefined`
 * when the replica records none.
 */
export function readStatisticsLimit(db: Database): number | null | undefined {
  return db
    .prepare(`SELECT analysisLimit FROM "_zero.statistics"`)
    .get<{analysisLimit: number | null} | undefined>()?.analysisLimit;
}

/**
 * Gathers the replica's statistics under the connection's `analysis_limit`:
 * those of every table when the replica records none, or another limit, and
 * otherwise those of each table that SQLite finds without statistics or ten
 * times larger or smaller than when they were gathered.
 */
export function gatherStatistics(lc: LogContext, db: Database): void {
  const start = performance.now();
  const [{analysis_limit: analysisLimit}] = db.pragma<{
    analysis_limit: number;
  }>('analysis_limit');
  const recorded = readStatisticsLimit(db);

  if (
    (recorded === null ? EARLIER_ANALYSIS_LIMIT : recorded) === analysisLimit
  ) {
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
  const gatheredBefore =
    recorded === null
      ? 'an earlier zero-cache gathered them'
      : `it recorded ${recorded ?? 'no limit'}`;
  lc.info?.(
    `analyzed every table of ${db.name} under analysis_limit ${analysisLimit}, ` +
      `where ${gatheredBefore} (${(performance.now() - start).toFixed(2)} ms)`,
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
