import {defineConfig, mergeConfig} from 'vitest/config';
import config, {
  benchConfig,
  CI,
  pgProjectDefaults,
} from '../shared/src/tool/vitest-config.ts';

const coverageInclude = ['src/**/*.{js,jsx,ts,tsx,mjs,mts,cjs,cts}'];

function nameFromURL(url: string) {
  // importer looks like file://....../packages/NAME/... and we want the NAME
  return url.match(/\/packages\/([^/]+)/)?.[1] ?? 'unknown';
}

export function configForVersion(version: number, url: string) {
  const name = nameFromURL(url);
  const merged = mergeConfig(config, {
    test: {
      ...pgProjectDefaults(),
      name: `${name}/pg-${version}`,
      globalSetup: [`../zero-cache/test/pg-${version}.ts`],
      coverage: {
        enabled: !CI, // Don't run coverage in continuous integration.
        reporter: [['html'], ['clover', {file: 'coverage.xml'}]],
        include: coverageInclude,
      },
    },
  });
  // Override include to only pg tests (mergeConfig merges arrays, we want to replace)
  merged.test.include = ['src/**/*.pg.test.?(c|m)[jt]s?(x)'];
  merged.test.exclude = [];
  return merged;
}

export function configForNoPg(url: string) {
  const name = nameFromURL(url);
  return mergeConfig(config, {
    test: {
      name: `${name}/no-pg`,
      include: ['src/**/*.test.?(c|m)[jt]s?(x)'],
      exclude: ['src/**/*.pg.test.?(c|m)[jt]s?(x)'],
      browser: {enabled: false},
      silent: 'passed-only',
      coverage: {
        enabled: !CI, // Don't run coverage in continuous integration.
        reporter: [['html'], ['clover', {file: 'coverage.xml'}]],
        include: coverageInclude,
      },
    },
  });
}

export function configForPgBench(url: string) {
  const name = nameFromURL(url);
  const merged = mergeConfig(benchConfig, {
    test: {
      name: `${name}/bench-pg`,
      globalSetup: ['../zero-cache/test/pg-17.ts'],
      browser: {enabled: false},
      testTimeout: 300_000,
      hookTimeout: 300_000,
    },
  });
  // Override include to only pg benchmarks (mergeConfig merges arrays).
  merged.test.include = ['src/**/*.bench.pg.?(c|m)[jt]s?(x)'];
  return merged;
}

// To run tests against a custom Postgres instance (e.g. Aurora), specify
// the connection string in the CUSTOM_PG environment variable, and optionally
// limit the test runner to the "custom-pg" project:
//
// CUSTOM_PG=postgresql://... pnpm run test --project custom-pg
export function configForCustomPg(url: string) {
  if (process.env['CUSTOM_PG']) {
    const name = nameFromURL(url);
    return [
      mergeConfig(config, {
        test: {
          name: `${name}/custom-pg`,
          // The same defaults as the versioned pg projects. It runs the same
          // files against one Postgres, so it wants the same budget, the same
          // concurrency bound and the same group — spreading them here is also
          // what makes "a pg project grants the pg budget" true of every pg
          // project rather than of most of them.
          ...pgProjectDefaults(),
          include: ['src/**/*.pg.test.?(c|m)[jt]s?(x)'],
          exclude: [],
          provide: {
            // Referenced by ./src/test/db.ts
            pgConnectionString: process.env['CUSTOM_PG'],
          },
        },
      }),
    ];
  }
  return [];
}

export default defineConfig({
  test: {
    projects: [
      'vitest.config.*.ts',
      '!vitest.config.bench.ts',
      '!vitest.config.bench.*.ts',
      ...configForCustomPg(import.meta.url),
    ],
  },
});
