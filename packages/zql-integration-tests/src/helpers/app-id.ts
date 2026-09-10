import {createHash} from 'node:crypto';

/**
 * Room left for the `_<digest>` and the `_<shard>_<role>` a slot name appends.
 *
 * Postgres does not reject an over-long slot name, it silently TRUNCATES to 63
 * bytes — so two ids sharing a long prefix would become one stored slot name, and
 * the pool that allocates `prefix_a`, `prefix_b`, … would keep colliding with a
 * name it cannot see is the same. Bounding the id is what keeps that unreachable.
 */
const MAX_SANITIZED_LENGTH = 40;

/**
 * A slot-safe app id for a test database: replication slot names allow only
 * [a-z0-9_].
 *
 * Sanitising alone is lossy — `collate-test`, `collate_test`, `collate.test` and
 * `Collate-Test` all collapse to `collate_test` — which would put two databases on
 * one slot and reproduce the collision this exists to prevent. So a name that had
 * to be changed also carries a digest of the original, which keeps distinct
 * databases on distinct slots while leaving already-safe names untouched.
 *
 * Its own module because it is a pure function: `setup.ts` reaches the Postgres
 * test harness at import time, so anything living there can only be tested from a
 * `.pg.test.ts` file with a container behind it.
 */
export function appIdFor(dbName: string): string {
  const sanitized = dbName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '_');
  // Both conditions before returning the name as-is: comparing a truncated
  // `sanitized` against the full `dbName` would attribute a length overrun to
  // sanitising, and take a digest of a name that never needed one.
  if (sanitized === dbName && sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized;
  }
  const digest = createHash('sha256').update(dbName).digest('hex').slice(0, 8);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}_${digest}`;
}
