import {expect, test} from 'vitest';
import {copyWorkerCount, MAX_COPY_WORKERS} from './initial-sync.ts';

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

// The ceiling on upstream connections. A worker is a connection, so the win32
// branch — which counts TABLES rather than a setting — is what makes a ceiling
// necessary: nothing about a publication's size is bounded.
test.each([
  // Below the ceiling nothing changes: one worker per table, as before.
  [5, 7, 7],
  [5, MAX_COPY_WORKERS, MAX_COPY_WORKERS],
  // Above it, the table count no longer decides how many connections are opened.
  [5, MAX_COPY_WORKERS + 1, MAX_COPY_WORKERS],
  [5, 1_182, MAX_COPY_WORKERS],
] as const)(
  'on win32, %i requested over %i tables opens %i connections',
  (requested, numTables, expected) => {
    expect(copyWorkerCount({requested, numTables, platform: 'win32'})).toBe(
      expected,
    );
  },
);

test('an operator who asks for more than the ceiling still gets it', () => {
  // The ceiling bounds what the platform workaround adds on its own. Lowering a
  // count the operator set explicitly would be a different surprise, and they
  // have already accepted the connection cost by naming it.
  const requested = MAX_COPY_WORKERS * 3;
  expect(
    copyWorkerCount({requested, numTables: 10_000, platform: 'win32'}),
  ).toBe(requested);
  expect(
    copyWorkerCount({requested, numTables: 10_000, platform: 'linux'}),
  ).toBe(requested);
});

test('the ceiling never invents work there are no tables for', () => {
  expect(copyWorkerCount({requested: 5, numTables: 3, platform: 'win32'})).toBe(
    3,
  );
  expect(copyWorkerCount({requested: 5, numTables: 0, platform: 'win32'})).toBe(
    0,
  );
});
