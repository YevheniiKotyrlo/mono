import {expect, test} from 'vitest';
import {
  copyWorkerCount,
  PER_TABLE_WORKER_CEILING,
  PER_TABLE_WORKER_SHARE,
  perTableWorkerCeiling,
} from './initial-sync.ts';

/** Postgres's own default, which the ceiling is sized against. */
const DEFAULT_MAX_CONNECTIONS = 100;

test.each([
  [1, 7, 1],
  [4, 7, 4],
  // Capped at the table count: extra workers have nothing to copy.
  [9, 7, 7],
] as const)(
  'with shared connections, %i requested over %i tables uses %i workers',
  (requested, numTables, expected) => {
    expect(
      copyWorkerCount({
        requested,
        numTables,
        workerPerTable: false,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
      }),
    ).toBe(expected);
  },
);

test.each([
  [1, 7, 7],
  [4, 7, 7],
  [1, 1, 1],
  [9, 7, 7],
] as const)(
  'with a worker per table, %i requested over %i tables uses %i',
  (requested, numTables, expected) => {
    expect(
      copyWorkerCount({
        requested,
        numTables,
        workerPerTable: true,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
      }),
    ).toBe(expected);
  },
);

test('a table count of zero asks for no workers either way', () => {
  for (const workerPerTable of [false, true]) {
    expect(
      copyWorkerCount({
        requested: 4,
        numTables: 0,
        workerPerTable,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
      }),
    ).toBe(0);
  }
});

test('the requested count and the table count are not interchangeable', () => {
  // Only the worker-per-table branch reads one without the other; the shared
  // branch is symmetric under Math.min by construction.
  const shared = {
    workerPerTable: true,
    maxConnections: DEFAULT_MAX_CONNECTIONS,
  } as const;
  expect(copyWorkerCount({requested: 1, numTables: 7, ...shared})).not.toBe(
    copyWorkerCount({requested: 7, numTables: 1, ...shared}),
  );
});

test('the ceiling is a share of the server limit, not a fixed number', () => {
  expect(PER_TABLE_WORKER_SHARE).toBe(0.25);
  expect(PER_TABLE_WORKER_CEILING).toBe(50);

  // A managed Postgres at 25, where a fixed 50 would protect nothing.
  expect(perTableWorkerCeiling(25)).toBe(6);
  expect(perTableWorkerCeiling(100)).toBe(25);
  expect(perTableWorkerCeiling(1_000)).toBe(50);
  // Never zero, which the transaction pool downstream rejects.
  expect(perTableWorkerCeiling(1)).toBe(1);
  expect(perTableWorkerCeiling(0)).toBe(1);
});

test.each([
  // Below the ceiling nothing changes: one worker per table.
  [5, 7, 100, 7],
  [5, 25, 100, 25],
  // Above it, the table count no longer decides how many connections open.
  [5, 26, 100, 25],
  [5, 1_182, 100, 25],
  // And the bound moves with the server.
  [5, 1_182, 25, 6],
  [5, 1_182, 10_000, 50],
] as const)(
  'with a worker per table, %i requested over %i tables at max_connections %i opens %i',
  (requested, numTables, maxConnections, expected) => {
    expect(
      copyWorkerCount({
        requested,
        numTables,
        workerPerTable: true,
        maxConnections,
      }),
    ).toBe(expected);
  },
);

test('an operator who asks for more than the ceiling still gets it', () => {
  const requested = PER_TABLE_WORKER_CEILING * 3;
  for (const workerPerTable of [true, false]) {
    expect(
      copyWorkerCount({
        requested,
        numTables: 10_000,
        workerPerTable,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
      }),
    ).toBe(requested);
  }
});
