import {expect, test} from 'vitest';
import {
  isExternalModuleId,
  isFileModuleId,
  isResolvableFileSpecifier,
  packageName,
} from './build.ts';

const INLINED = new Set(['@oxc-project/runtime']);

test.each([
  'C:\\repo\\packages\\zero\\src\\zero.ts',
  'C:/repo/packages/zero/src/zero.ts',
  'C:a.ts',
  '\\\\server\\share\\src\\a.ts',
  '/repo/packages/zero/src/zero.ts',
  './a.ts',
  '../b/c.ts',
  '\0virtual:module',
])('bundles the file id %s', id => {
  expect(isFileModuleId(id)).toBe(true);
  expect(isExternalModuleId(id, INLINED)).toBe(false);
});

test.each(['kysely', 'node:fs', '@rocicorp/logger', 'drizzle-orm/pg-core'])(
  'leaves the package id %s external',
  id => {
    expect(isFileModuleId(id)).toBe(false);
    expect(isExternalModuleId(id, INLINED)).toBe(true);
  },
);

test.each(['@oxc-project/runtime', '@oxc-project/runtime/helpers/x'])(
  'bundles the inlined package id %s',
  id => {
    expect(isExternalModuleId(id, INLINED)).toBe(false);
  },
);

test.each([
  ['@scope/pkg/deep/path', '@scope/pkg'],
  ['pkg/subpath', 'pkg'],
  ['pkg', 'pkg'],
])('packageName(%s) is %s', (id, expected) => {
  expect(packageName(id)).toBe(expected);
});

test.each(['./a.js', '../shared/src/asserts.js', './data.json?raw'])(
  'a consumer resolves the output specifier %s',
  id => {
    expect(isResolvableFileSpecifier(id)).toBe(true);
  },
);

test.each([
  '../../zero-client/src/mod.ts',
  './view.tsx',
  './worker.mts?worker',
  'C:/repo/packages/zero/out/a.js',
  '/repo/packages/zero/out/a.js',
  '\0virtual:module',
])('a consumer cannot resolve the output specifier %s', id => {
  expect(isResolvableFileSpecifier(id)).toBe(false);
});
