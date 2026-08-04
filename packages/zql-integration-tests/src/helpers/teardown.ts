/**
 * Runs every teardown step even when an earlier one throws, then reports all the
 * failures together.
 *
 * A straight-line `afterAll` abandons the rest of its work at the first throw:
 * with `await client.end(); sqlite.close(); await testDBs.drop(pg)`, a dead socket
 * in the first statement leaves the database and its replication slot behind for
 * the remainder of the run — the leak the drop exists to prevent, reported only as
 * a warning from a later file. Each step therefore runs independently.
 *
 * Reporting every failure rather than the first also matters here: teardown
 * failures come in causal chains, and the second one is usually the one that
 * explains the first.
 */
export async function releaseAll(
  steps: readonly (() => unknown)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      // A step may be synchronous (`sqlite.close()`); awaiting a non-promise is
      // fine and keeps the two cases from needing different call shapes.
      await step();
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 0) {
    // The message carries the first failure because runners show `error.message`
    // and would otherwise print only "N teardown steps failed".
    throw new AggregateError(
      failures,
      `${failures.length} teardown steps failed, first: ${
        failures[0] instanceof Error ? failures[0].message : String(failures[0])
      }`,
    );
  }
}
