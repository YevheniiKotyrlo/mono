import {availableParallelism} from 'node:os';
import {playwright} from '@vitest/browser-playwright';
import {defineConfig} from 'vitest/config';
import type {BrowserConfigOptions} from 'vitest/node';
import {makeDefine} from '../build.ts';

/**
 * How many pg test files may run at once.
 *
 * These projects contend on ONE Postgres server, not on CPUs, so vitest's default
 * of `availableParallelism() - 1` oversubscribes it: every file opens a pool and
 * does real I/O against the same instance, and past a handful the server and its
 * disk are the bottleneck. The extra workers do not run in parallel so much as
 * take turns being slow.
 *
 * Measured on a 32-core machine over the same 79-file project: unbounded finished
 * in 214s having spent 3084s of test time, with one case timing out; six workers
 * finished in 252s having spent 973s, with none. Thirty-eight seconds of wall
 * clock buys a third of the work and the difference between a suite that flakes
 * and one that does not — a case that runs in 1.6s alone was taking 30s.
 *
 * Capped rather than fixed, so a machine with fewer cores still gets vitest's own
 * limit. Shared because every pg project has to agree: vitest rejects projects in
 * one `sequence.groupOrder` that disagree on `maxWorkers`.
 */
export function maxConcurrentPgFiles(): number {
  return Math.min(Math.max(availableParallelism() - 1, 1), 6);
}

/**
 * The settings every Postgres-backed project shares.
 *
 * One definition rather than a copy per project, because these are not
 * preferences — `maxWorkers` in particular MUST match across them, since vitest
 * refuses to run projects that sit in one `sequence.groupOrder` and disagree on
 * it, and the error names the two projects rather than the reason. Agreement by
 * construction is the only kind that survives a project being added.
 *
 * Timeouts and retries are here for the same reason they are worth sharing: a pg
 * project waits on a real server, so it needs a budget that reflects that, and a
 * project that quietly kept the defaults is a project that fails differently from
 * its siblings for no stated reason.
 */
export function pgProjectDefaults() {
  const timeout = (CI ? 2 : 1) * 30_000;
  return {
    browser: {enabled: false},
    silent: 'passed-only',
    maxWorkers: maxConcurrentPgFiles(),
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
