import {expect, test} from 'vitest';
import {selectProjectConfigs} from './vitest-projects.ts';

// The defect: `packages/zero-client` declares exactly these two, so the bench
// config displaced the base config and was then skipped itself. The package
// contributed no project, and its 41 files — 664 tests — ran nowhere, which is
// how one of them came to be red on `main` unnoticed.
test('a bench config does not displace the base config', () => {
  expect(
    selectProjectConfigs(['vitest.config.bench.ts', 'vitest.config.ts']),
  ).toEqual(['vitest.config.ts']);
});

test('a real variant does displace the base config', () => {
  expect(
    selectProjectConfigs([
      'vitest.config.no-pg.ts',
      'vitest.config.pg-16.ts',
      'vitest.config.ts',
    ]),
  ).toEqual(['vitest.config.no-pg.ts', 'vitest.config.pg-16.ts']);
});

test('variants and benches together keep the variants only', () => {
  expect(
    selectProjectConfigs([
      'vitest.config.bench.node.ts',
      'vitest.config.bench.ts',
      'vitest.config.node.ts',
      'vitest.config.ts',
      'vitest.config.web.ts',
    ]),
  ).toEqual(['vitest.config.node.ts', 'vitest.config.web.ts']);
});

test('a directory with only a base config keeps it', () => {
  expect(selectProjectConfigs(['vitest.config.ts'])).toEqual([
    'vitest.config.ts',
  ]);
});

test('the repo root drops its own config, which would recurse', () => {
  expect(selectProjectConfigs(['vitest.config.ts'], true)).toEqual([]);
});
