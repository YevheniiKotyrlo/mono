import {expect, test} from 'vitest';
import {copyWorkerCount} from './initial-sync.ts';

// The platform is a parameter precisely so both outcomes are covered wherever this
// runs. Reading it from the host instead would leave the Windows branch — the one
// that exists to work around a Node/Postgres bug — unexercised on CI.

test.each([
  ['linux', 1, 7, 1],
  ['linux', 4, 7, 4],
  ['darwin', 4, 7, 4],
  // Capped at the table count: extra workers have nothing to copy.
  ['linux', 9, 7, 7],
  ['darwin', 9, 7, 7],
] as const)(
  'on %s, %i requested over %i tables uses %i workers',
  (platform, requested, numTables, expected) => {
    expect(copyWorkerCount({requested, numTables, platform})).toBe(expected);
  },
);

test.each([
  [1, 7, 7],
  [4, 7, 7],
  [1, 1, 1],
  // Already above the table count, so the platform makes no difference.
  [9, 7, 7],
] as const)(
  'on win32, %i requested over %i tables uses %i — one per table',
  (requested, numTables, expected) => {
    // Sharing a connection across several COPY streams on Windows trips a
    // Node/Postgres bug where the connection stops responding, so each worker
    // gets exactly one table.
    expect(copyWorkerCount({requested, numTables, platform: 'win32'})).toBe(
      expected,
    );
  },
);

test('a table count of zero asks for no workers on either platform', () => {
  expect(copyWorkerCount({requested: 4, numTables: 0, platform: 'linux'})).toBe(
    0,
  );
  expect(copyWorkerCount({requested: 4, numTables: 0, platform: 'win32'})).toBe(
    0,
  );
});

test('the two counts are not interchangeable', () => {
  // Why they are named rather than positional: on the POSIX branch `Math.min` is
  // symmetric, so swapping them is undetectable by any test — including this one.
  // Only the win32 branch, which reads one of them, can tell them apart.
  expect(copyWorkerCount({requested: 1, numTables: 7, platform: 'linux'})).toBe(
    copyWorkerCount({requested: 7, numTables: 1, platform: 'linux'}),
  );
  expect(
    copyWorkerCount({requested: 1, numTables: 7, platform: 'win32'}),
  ).not.toBe(copyWorkerCount({requested: 7, numTables: 1, platform: 'win32'}));
});
