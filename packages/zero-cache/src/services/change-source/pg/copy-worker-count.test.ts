import {expect, test} from 'vitest';
import {
  copyWorkerCount,
  copyWorkerWarnings,
  perTableWorkerCeiling,
} from './initial-sync.ts';

test.each([
  [1, 7, 1],
  [4, 7, 4],
  [9, 7, 7],
  [4, 0, 0],
] as const)(
  'with shared connections, %i requested over %i tables uses %i workers',
  (requested, numTables, expected) => {
    expect(
      copyWorkerCount({
        requested,
        numTables,
        workerPerTable: false,
        maxConnections: 100,
      }),
    ).toBe(expected);
  },
);

test.each([
  [1, 7, 100, 7],
  [5, 25, 100, 25],
  [5, 26, 100, 25],
  [5, 1_182, 100, 25],
  [5, 1_182, 25, 6],
  [5, 1_182, 10_000, 50],
  [40, 100, 100, 40],
  [4, 0, 100, 0],
] as const)(
  'with a worker per table, %i requested over %i tables at max_connections %i uses %i',
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

test.each([
  [25, 6],
  [100, 25],
  [1_000, 50],
  [1, 1],
  [0, 1],
] as const)(
  'at max_connections %i the raise opens at most %i workers',
  (maxConnections, expected) => {
    expect(perTableWorkerCeiling(maxConnections)).toBe(expected);
  },
);

test('a raise is reported with the count it raises to', () => {
  expect(
    copyWorkerWarnings({
      requested: 5,
      numTables: 7,
      workerPerTable: true,
      maxConnections: 100,
      numWorkers: 7,
    }),
  ).toEqual([
    'Increasing the number of copy workers from 5 to 7 to work around a ' +
      'postgres.js connection bug ' +
      '(https://github.com/porsager/postgres/issues/499)',
  ]);
});

test('tables left sharing a worker name the requested count that gives each its own', () => {
  const [, shared] = copyWorkerWarnings({
    requested: 5,
    numTables: 1_182,
    workerPerTable: true,
    maxConnections: 100,
    numWorkers: 25,
  });

  expect(shared).toContain('1182 tables share 25 copy workers');
  expect(shared).toContain('--table-copy-workers 1182');
});

test('shared connections report nothing', () => {
  expect(
    copyWorkerWarnings({
      requested: 4,
      numTables: 1_182,
      workerPerTable: false,
      maxConnections: 100,
      numWorkers: 4,
    }),
  ).toEqual([]);
});
