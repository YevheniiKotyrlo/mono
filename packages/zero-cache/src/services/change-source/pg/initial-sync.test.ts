import type postgres from 'postgres';
import {describe, expect, test, vi} from 'vitest';
import {createSilentLogContext} from '../../../../../shared/src/logging-test-utils.ts';
import type {PublishedTableSpec} from '../../../db/specs.ts';
import type {PostgresDB} from '../../../types/pg.ts';
import {
  computeCopyWorkers,
  getInitialDownloadState,
  makeDownloadStatements,
  mapWithConcurrency,
  MAX_COPY_CONCURRENCY,
} from './initial-sync.ts';
import {createReplicationSlot} from './replication-slots.ts';

function spec(
  publications: Record<string, {rowFilter: string | null}> = {
    pub1: {rowFilter: null},
  },
): PublishedTableSpec {
  return {
    schema: 'public',
    name: 't',
    publications,
  } as unknown as PublishedTableSpec;
}

describe('computeCopyWorkers', () => {
  test('honors the configured worker count when below the cap', () => {
    expect(computeCopyWorkers(1, 1200)).toBe(1);
    expect(computeCopyWorkers(3, 1200)).toBe(3);
    expect(computeCopyWorkers(MAX_COPY_CONCURRENCY, 1200)).toBe(
      MAX_COPY_CONCURRENCY,
    );
  });

  test('caps a large schema — no longer one connection per table on win32', () => {
    // The win32 defect sized the pool to numTables; the cap removes it, so the
    // worker count never scales with the number of tables.
    expect(computeCopyWorkers(100, 1200)).toBe(MAX_COPY_CONCURRENCY);
    expect(computeCopyWorkers(MAX_COPY_CONCURRENCY + 50, 1200)).toBe(
      MAX_COPY_CONCURRENCY,
    );
    expect(
      computeCopyWorkers(Number.MAX_SAFE_INTEGER, 5000),
    ).toBeLessThanOrEqual(MAX_COPY_CONCURRENCY);
  });

  test('never starts more workers than there are tables', () => {
    expect(computeCopyWorkers(MAX_COPY_CONCURRENCY, 10)).toBe(10);
    expect(computeCopyWorkers(3, 2)).toBe(2);
    expect(computeCopyWorkers(1, 1)).toBe(1);
  });

  test('handles the empty-schema edge', () => {
    expect(computeCopyWorkers(MAX_COPY_CONCURRENCY, 0)).toBe(0);
  });
});

describe('mapWithConcurrency', () => {
  test('preserves input order even when tasks finish out of order', async () => {
    const results = await mapWithConcurrency([1, 2, 3, 4], 4, async value => {
      // Earlier items finish later, exercising out-of-order completion.
      await new Promise(resolve => setTimeout(resolve, (5 - value) * 10));
      return value * 10;
    });
    expect(results).toEqual([10, 20, 30, 40]);
  });

  test('runs every item exactly once', async () => {
    const seen: number[] = [];
    const results = await mapWithConcurrency([1, 2, 3, 4, 5], 3, value => {
      seen.push(value);
      return Promise.resolve(value);
    });
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(seen.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test('empty input resolves to [] without invoking the task', async () => {
    const task = vi.fn((value: number) => Promise.resolve(value));
    const results = await mapWithConcurrency([], 4, task);
    expect(results).toEqual([]);
    expect(task).not.toHaveBeenCalled();
  });

  test('never exceeds the concurrency limit', async () => {
    const limit = 3;
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({length: 12}, (_, index) => index),
      limit,
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight--;
      },
    );
    expect(maxInFlight).toBe(limit);
  });

  test('caps in-flight work at the item count when limit exceeds it', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2], 10, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight--;
    });
    expect(maxInFlight).toBe(2);
  });

  test('rejects when a task rejects', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, value =>
        value === 2
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(value),
      ),
    ).rejects.toThrow('boom');
  });

  test('stops starting tasks after the first failure', async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5], 1, value => {
        started.push(value);
        return value === 2
          ? Promise.reject(new Error('boom'))
          : Promise.resolve(value);
      }),
    ).rejects.toThrow('boom');
    // Serial (limit 1): item 1 succeeds, item 2 throws, so items 3-5 are never
    // started — no work is launched once a failure is seen.
    expect(started).toEqual([1, 2]);
  });

  test('awaits in-flight tasks before rejecting (no orphaned task)', async () => {
    let siblingSettled = false;
    await expect(
      mapWithConcurrency([1, 2], 2, async value => {
        if (value === 1) {
          throw new Error('boom');
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        siblingSettled = true;
        return value;
      }),
    ).rejects.toThrow('boom');
    // The sibling that was already in flight when item 1 failed must be awaited
    // to completion rather than left dangling as an unhandled rejection.
    expect(siblingSettled).toBe(true);
  });
});

describe('makeDownloadStatements', () => {
  test('default path has no TABLESAMPLE or LIMIT', () => {
    const stmts = makeDownloadStatements(spec(), ['a', 'b']);
    expect(stmts.select).not.toMatch(/TABLESAMPLE/i);
    expect(stmts.select).not.toMatch(/\bLIMIT\b/i);
    expect(stmts.getTotalRows).not.toMatch(/TABLESAMPLE/i);
    expect(stmts.getTotalRows).not.toMatch(/FROM \(/i);
    expect(stmts.getTotalBytes).not.toMatch(/TABLESAMPLE/i);
    expect(stmts.getTotalBytes).not.toMatch(/FROM \(/i);
    expect(stmts.select).toBe(`SELECT "a","b" FROM "public"."t" `);
  });

  test('sampleRate === 1 does not inject TABLESAMPLE', () => {
    const stmts = makeDownloadStatements(spec(), ['a'], 1);
    expect(stmts.select).not.toMatch(/TABLESAMPLE/i);
    expect(stmts.select).not.toMatch(/\bLIMIT\b/i);
  });

  test('sampleRate undefined does not inject TABLESAMPLE', () => {
    const stmts = makeDownloadStatements(spec(), ['a'], undefined);
    expect(stmts.select).not.toMatch(/TABLESAMPLE/i);
  });

  test('sampleRate < 1 injects TABLESAMPLE BERNOULLI', () => {
    const stmts = makeDownloadStatements(spec(), ['a'], 0.25);
    expect(stmts.select).toMatch(/ TABLESAMPLE BERNOULLI\(25\) /);
    expect(stmts.getTotalRows).toMatch(/ TABLESAMPLE BERNOULLI\(25\) /);
    expect(stmts.getTotalBytes).toMatch(/ TABLESAMPLE BERNOULLI\(25\) /);
    // No LIMIT without maxRowsPerTable.
    expect(stmts.select).not.toMatch(/\bLIMIT\b/i);
  });

  test('maxRowsPerTable injects LIMIT and wraps counts in subquery', () => {
    const stmts = makeDownloadStatements(spec(), ['a', 'b'], undefined, 50);
    expect(stmts.select).toMatch(/ LIMIT 50$/);
    expect(stmts.getTotalRows).toMatch(
      /SELECT COUNT\(\*\)::bigint AS "totalRows" FROM \(SELECT 1 AS _ FROM .* LIMIT 50\) s/,
    );
    expect(stmts.getTotalBytes).toMatch(
      /SELECT COALESCE\(SUM\(b\), 0\)::bigint AS "totalBytes" FROM \(SELECT \(.+\) AS b FROM .* LIMIT 50\) s/,
    );
  });

  test('sample + limit compose', () => {
    const stmts = makeDownloadStatements(spec(), ['a'], 0.5, 10);
    expect(stmts.select).toMatch(
      /SELECT "a" FROM "public"\."t" TABLESAMPLE BERNOULLI\(50\) \s*LIMIT 10$/,
    );
    expect(stmts.getTotalRows).toMatch(/TABLESAMPLE BERNOULLI\(50\)/);
    expect(stmts.getTotalRows).toMatch(/LIMIT 10\) s$/);
  });

  test('row filters still appear in WHERE clause alongside sampling', () => {
    const stmts = makeDownloadStatements(
      spec({p: {rowFilter: 'a > 10'}}),
      ['a'],
      0.5,
    );
    expect(stmts.select).toMatch(
      /FROM "public"\."t" TABLESAMPLE BERNOULLI\(50\) WHERE a > 10/,
    );
  });
});

describe('getInitialDownloadState', () => {
  function tableSpec(): PublishedTableSpec {
    return {
      schema: 'public',
      name: 't',
      columns: {a: {dataType: 'int4'}, b: {dataType: 'text'}},
      publications: {pub1: {rowFilter: null}},
    } as unknown as PublishedTableSpec;
  }

  test('skipTotals=true returns zeros without touching the DB', async () => {
    let called = false;
    const sql = Object.assign(
      () => {
        called = true;
        throw new Error('sql should not be called when skipTotals=true');
      },
      {
        unsafe() {
          called = true;
          throw new Error('sql should not be called when skipTotals=true');
        },
      },
    ) as unknown as PostgresDB;

    const state = await getInitialDownloadState(
      createSilentLogContext(),
      sql,
      tableSpec(),
      true,
    );
    expect(called).toBe(false);
    expect(state.status).toEqual({
      table: 't',
      columns: ['a', 'b'],
      rows: 0,
      totalRows: 0,
      totalBytes: 0,
    });
  });

  test('skipTotals=false uses pg_class estimates', async () => {
    // The tagged template sql`...` is called as a function with
    // (strings, ...values) when used as a template tag.
    const sql = Object.assign(
      (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const query = strings.join('$1');
        if (query.includes('pg_class')) {
          return Promise.resolve([{totalRows: 42, totalBytes: 8192}]);
        }
        return Promise.resolve([]);
      },
      {
        unsafe() {
          throw new Error('unsafe should not be called');
        },
      },
    ) as unknown as PostgresDB;

    const state = await getInitialDownloadState(
      createSilentLogContext(),
      sql,
      tableSpec(),
      false,
    );
    expect(state.status.totalRows).toBe(42);
    expect(state.status.totalBytes).toBe(8192);
  });
});

describe('createReplicationSlot', () => {
  /** Builds a mock session whose `unsafe` calls are handled by `handler`. */
  function mockSession(handler: (stmt: string) => Promise<unknown>) {
    return {
      unsafe: vi.fn(handler),
      end: vi.fn(() => Promise.resolve()),
    } as unknown as postgres.Sql;
  }

  test('returns the slot on success', async () => {
    const slot = {
      slot_name: 'test_slot',
      consistent_point: '0/1',
      snapshot_name: 'snap',
      output_plugin: 'pgoutput',
    };
    const session = mockSession(stmt => {
      if (stmt.startsWith('SET lock_timeout')) {
        return Promise.resolve([]);
      }
      // CREATE_REPLICATION_SLOT
      return Promise.resolve([slot]);
    });

    const result = await createReplicationSlot(
      createSilentLogContext(),
      session,
      {slotName: 'test_slot'},
    );
    expect(result).toEqual(slot);
  });

  test('sets lock_timeout before creating the slot', async () => {
    const calls: string[] = [];
    const session = mockSession(stmt => {
      calls.push(stmt);
      if (stmt.startsWith('SET lock_timeout')) {
        return Promise.resolve([]);
      }
      return Promise.resolve([
        {
          slot_name: 's',
          consistent_point: '0/1',
          snapshot_name: 'snap',
          output_plugin: 'pgoutput',
        },
      ]);
    });

    await createReplicationSlot(createSilentLogContext(), session, {
      slotName: 's',
    });
    expect(calls[0]).toMatch(/^SET lock_timeout = \d+$/);
    expect(calls[1]).toMatch(/CREATE_REPLICATION_SLOT/);
  });

  test('propagates server-side errors (e.g. lock_not_available)', async () => {
    const pgError = new Error('canceling statement due to lock timeout');
    (pgError as unknown as {code: string}).code = '55P03';

    const session = mockSession(stmt => {
      if (stmt.startsWith('SET lock_timeout')) {
        return Promise.resolve([]);
      }
      return Promise.reject(pgError);
    });

    await expect(
      createReplicationSlot(createSilentLogContext(), session, {
        slotName: 'test_slot',
      }),
    ).rejects.toBe(pgError);
  });

  test('falls back to client-side timeout when session hangs', async () => {
    vi.useFakeTimers();
    try {
      const session = mockSession(stmt => {
        if (stmt.startsWith('SET lock_timeout')) {
          return Promise.resolve([]);
        }
        // Simulate a hang: never resolve (e.g. network partition where
        // the server aborted but the client never receives the error).
        return new Promise(() => {});
      });

      // Capture the rejection eagerly to avoid an unhandled rejection
      // between the time advanceTimersByTimeAsync triggers it and the
      // time we assert on it.
      let caught: unknown;
      const result = createReplicationSlot(createSilentLogContext(), session, {
        slotName: 'hang_slot',
      }).catch(e => {
        caught = e;
      });

      // Advance past the 30s client-side timeout.
      await vi.advanceTimersByTimeAsync(31_000);
      await result;

      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).toMatch(
        /Timed out after \d+ ms creating replication slot hang_slot/,
      );

      // session.end() is called in the background to tear down the
      // orphaned connection.
      expect(
        (session.end as ReturnType<typeof vi.fn>).mock.calls.length,
      ).toBeGreaterThanOrEqual(1);

      // Drain any remaining timers/microtasks before restoring real timers.
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }
  });
});
