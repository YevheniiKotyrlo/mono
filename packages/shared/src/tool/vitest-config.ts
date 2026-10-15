import {availableParallelism} from 'node:os';
import {playwright} from '@vitest/browser-playwright';
import {defineConfig} from 'vitest/config';
import type {BrowserConfigOptions} from 'vitest/node';
import {makeDefine} from '../build.ts';

/**
 * How many pg test files may run at once. These projects contend on one
 * Postgres server rather than on CPUs, so vitest's default of
 * `availableParallelism() - 1` oversubscribes it: past a handful of files the
 * server and its disk are the bottleneck, and cases time out under load that
 * pass alone. Capped rather than fixed, so a machine with fewer cores keeps
 * vitest's own limit.
 */
export function maxConcurrentPgFiles(): number {
  return Math.min(Math.max(availableParallelism() - 1, 1), 6);
}

/** The most a pg project grants a case, which is what CI gets. */
const MAX_PG_TEST_TIMEOUT_MS = 60_000;

/**
 * The group Postgres-backed projects run in, after the default-group ones, so
 * the fast suites report first.
 */
export const PG_PROJECT_GROUP_ORDER = 1;

/**
 * The settings every Postgres-backed project shares. One definition, because
 * vitest refuses to run projects in one `sequence.groupOrder` that disagree on
 * `maxWorkers`, and its error names the two projects rather than the reason.
 */
export function pgProjectDefaults() {
  const timeout = CI ? MAX_PG_TEST_TIMEOUT_MS : MAX_PG_TEST_TIMEOUT_MS / 2;
  return {
    browser: {enabled: false},
    silent: 'passed-only',
    maxWorkers: maxConcurrentPgFiles(),
    // A group of their own: they share a pool only with projects bounded the
    // same way, so the no-pg suite keeps its full width.
    sequence: {groupOrder: PG_PROJECT_GROUP_ORDER},
    retry: CI ? 2 : 0,
    testTimeout: timeout,
    hookTimeout: timeout,
    slowTestThreshold: timeout / 10,
  } as const;
}

export const CI = process.env['CI'] === 'true' || process.env['CI'] === '1';
const {VITEST_BROWSER} = process.env;
const coverageInclude = ['src/**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}'];

function assertValidBrowser(
  browser: string | undefined,
): asserts browser is 'chromium' | 'firefox' | 'webkit' | undefined {
  switch (browser) {
    case 'chromium':
    case 'firefox':
    case 'webkit':
    case undefined:
      return;
    default:
      throw new Error(`Invalid VITEST_BROWSER value: ${browser}`);
  }
}

assertValidBrowser(VITEST_BROWSER);

const define = {
  ...makeDefine(),
  'import.meta.env.VITEST': 'true',
};

const logSilenceMessages = [
  'Skipping license check for TEST_LICENSE_KEY.',
  'REPLICACHE LICENSE NOT VALID',
  'enableAnalytics false',
  'no such entity',
  'PokeHandler clearing due to unexpected poke error',
  'Not indexing value',
  'Zero starting up with no server URL',
];

const browser: BrowserConfigOptions = {
  enabled: true,
  provider: playwright(),
  headless: true,
  screenshotFailures: false,
  instances: VITEST_BROWSER
    ? ([{browser: VITEST_BROWSER}] as const)
    : [
        {browser: 'chromium'},
        ...(CI ? ([{browser: 'firefox'}, {browser: 'webkit'}] as const) : []),
      ],
};

export default defineConfig({
  define,

  test: {
    onConsoleLog(log: string) {
      for (const message of logSilenceMessages) {
        if (log.includes(message)) {
          return false;
        }
      }
      return undefined;
    },
    include: ['src/**/*.{test,spec}{,.node}.?(c|m)[jt]s?(x)'],
    // The public rocicorp/mono only has the test suites of some packages
    // (tools/public-sync/public-filter); the others keep their harness but
    // have no tests to run.
    passWithNoTests: true,
    silent: 'passed-only',
    browser,

    coverage: {
      provider: 'v8',
      include: coverageInclude,
    },
    typecheck: {
      enabled: false,
    },
    testTimeout: 10_000,
  },
});

const externalizedWarningRegExp =
  /has been externalized for browser compatibility/;

export const benchConfig = defineConfig({
  define: {
    ...define,
    'process.env.NO_COLOR': JSON.stringify(process.env.NO_COLOR ?? ''),
    'process.env.NODE_DISABLE_COLORS': JSON.stringify(
      process.env.NODE_DISABLE_COLORS ?? '',
    ),
    'process.env.BENCH_OUTPUT_FORMAT': JSON.stringify(
      process.env.BENCH_OUTPUT_FORMAT ?? '',
    ),
    'process.env.BENCH_SUMMARY': JSON.stringify(
      process.env.BENCH_SUMMARY ?? '',
    ),
  },

  test: {
    include: ['src/**/*.bench{,.node}.?(c|m)[jt]s?(x)'],
    disableConsoleIntercept: true,
    silent: false,
    onConsoleLog(str, type, _entity) {
      if (externalizedWarningRegExp.test(str)) {
        return false;
      }
      if (type === 'stderr') {
        console.error(str);
      } else {
        console.log(str);
      }
      return false;
    },
    browser,
    slowTestThreshold: 15_000,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Run bench files sequentially to avoid memory contention between workers.
    maxWorkers: 1,
  },

  optimizeDeps: {
    exclude: ['@mitata/counters'],
  },

  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
