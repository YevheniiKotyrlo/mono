import {expect, test} from 'vitest';
import {
  copyWorkerCount,
  win32CopyWorkerCeiling,
  WIN32_COPY_WORKER_CEILING,
  WIN32_COPY_WORKER_SHARE,
} from './initial-sync.ts';

// Every input is a parameter precisely so both outcomes are covered wherever this
// runs. Reading the platform from the host instead would leave the Windows branch
// — the one that exists to work around a Node/Postgres bug — unexercised on CI,
// and reading `max_connections` from a server would make the ceiling untestable
// without one.

/** Postgres's own default, which the ceiling is sized against. */
const DEFAULT_MAX_CONNECTIONS = 100;

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
    expect(
      copyWorkerCount({
        requested,
        numTables,
        platform,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
      }),
    ).toBe(expected);
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
    expect(
      copyWorkerCount({
        requested,
        numTables,
        platform: 'win32',
        maxConnections: DEFAULT_MAX_CONNECTIONS,
      }),
    ).toBe(expected);
  },
);

test('a table count of zero asks for no workers on either platform', () => {
  for (const platform of ['linux', 'win32'] as const) {
    expect(
      copyWorkerCount({
        requested: 4,
        numTables: 0,
        platform,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
      }),
    ).toBe(0);
  }
});

test('the requested count and the table count are not interchangeable', () => {
  // Why they are named rather than positional: only the win32 branch reads one of
  // them without the other, so it is the only branch that can tell a swapped pair
  // apart. The POSIX branch is symmetric under `Math.min` by construction, which
  // is exactly why this asserts on win32 alone rather than blessing that symmetry.
  const shared = {
    platform: 'win32',
    maxConnections: DEFAULT_MAX_CONNECTIONS,
  } as const;
  expect(copyWorkerCount({requested: 1, numTables: 7, ...shared})).not.toBe(
    copyWorkerCount({requested: 7, numTables: 1, ...shared}),
  );
});

// The ceiling on upstream connections. A worker is a connection, so the win32
// branch — which counts TABLES rather than a setting — is what makes a ceiling
// necessary: nothing about a publication's size is bounded.
test('the ceiling is a share of the server limit, not a fixed number', () => {
  // Pinned as literals, not re-derived: a ceiling derived from the constant it is
  // meant to check cannot detect that constant changing, which is the one thing
  // these numbers exist to hold.
  expect(WIN32_COPY_WORKER_SHARE).toBe(0.25);
  expect(WIN32_COPY_WORKER_CEILING).toBe(50);

  // A managed Postgres at 25, where a fixed 50 would have protected nothing.
  expect(win32CopyWorkerCeiling(25)).toBe(6);
  // Postgres's default. zero-cache's own budget already claims 56 of these when
  // cvr-db and change-db fall back to upstream-db, so a quarter is what is left
  // over rather than what is available.
  expect(win32CopyWorkerCeiling(100)).toBe(25);
  // Past the cap the share stops growing: more concurrent COPY streams than this
  // buy no throughput.
  expect(win32CopyWorkerCeiling(1_000)).toBe(50);
  // Never zero, which would assertion-fail the transaction pool downstream.
  expect(win32CopyWorkerCeiling(1)).toBe(1);
  expect(win32CopyWorkerCeiling(0)).toBe(1);
});

test.each([
  // Below the ceiling nothing changes: one worker per table, as before.
  [5, 7, 100, 7],
  [5, 25, 100, 25],
  // Above it, the table count no longer decides how many connections are opened.
  [5, 26, 100, 25],
  [5, 1_182, 100, 25],
  // And the bound moves with the server: the same publication against a smaller
  // limit opens fewer.
  [5, 1_182, 25, 6],
  [5, 1_182, 10_000, 50],
] as const)(
  'on win32, %i requested over %i tables at max_connections %i opens %i',
  (requested, numTables, maxConnections, expected) => {
    expect(
      copyWorkerCount({
        requested,
        numTables,
        platform: 'win32',
        maxConnections,
      }),
    ).toBe(expected);
  },
);

test('an operator who asks for more than the ceiling still gets it', () => {
  // The ceiling bounds what the platform workaround adds on its own. Lowering a
  // count the operator set explicitly would be a different surprise, and they
  // have already accepted the connection cost by naming it.
  const requested = WIN32_COPY_WORKER_CEILING * 3;
  for (const platform of ['win32', 'linux'] as const) {
    expect(
      copyWorkerCount({
        requested,
        numTables: 10_000,
        platform,
        maxConnections: DEFAULT_MAX_CONNECTIONS,
      }),
    ).toBe(requested);
  }
});

test('the ceiling never invents work there are no tables for', () => {
  expect(
    copyWorkerCount({
      requested: 5,
      numTables: 3,
      platform: 'win32',
      maxConnections: DEFAULT_MAX_CONNECTIONS,
    }),
  ).toBe(3);
  expect(
    copyWorkerCount({
      requested: 5,
      numTables: 0,
      platform: 'win32',
      maxConnections: DEFAULT_MAX_CONNECTIONS,
    }),
  ).toBe(0);
});
