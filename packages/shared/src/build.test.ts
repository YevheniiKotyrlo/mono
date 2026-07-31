import {expect, test} from 'vitest';
import {isExternalModuleId, isFileModuleId, packageName} from './build.ts';

// Windows-shaped ids are written out literally rather than built with path.join,
// so these assertions mean the same thing on every runner. The bug this guards
// is invisible on POSIX by construction: a leading-slash test is correct there,
// so only an explicitly Windows-shaped input can catch a regression.

test.each([
  'C:\\repo\\packages\\zero\\src\\zero.ts',
  'C:/repo/packages/zero/src/zero.ts',
  'D:\\other\\src\\a.ts',
  '\\\\server\\share\\src\\a.ts',
])('treats the Windows absolute id %s as a file', id => {
  expect(isFileModuleId(id)).toBe(true);
});

test.each(['/repo/packages/zero/src/zero.ts', '/a.ts'])(
  'treats the POSIX absolute id %s as a file',
  id => {
    expect(isFileModuleId(id)).toBe(true);
  },
);

test.each(['./a.ts', '../b/c.ts', '.'])(
  'treats the relative id %s as a file',
  id => {
    expect(isFileModuleId(id)).toBe(true);
  },
);

test('treats a bundler-virtual id as a file', () => {
  expect(isFileModuleId('\0virtual:module')).toBe(true);
});

test.each([
  'react',
  'solid-js',
  'kysely',
  '@rocicorp/logger',
  'node:fs',
  'drizzle-orm/node-postgres',
])('treats the bare specifier %s as not a file', id => {
  expect(isFileModuleId(id)).toBe(false);
});

test.each([
  ['C:foo\\bar.ts', true],
  ['C:a.ts', true],
])(
  'treats the Windows drive-relative id %s as a file',
  (id, expected: boolean) => {
    // Legal on Windows and a genuine file path. A single letter followed by ':'
    // cannot be a package name, so there is nothing to confuse it with — whereas
    // classifying it as a package would externalize it and then report the whole
    // path as an undeclared module.
    expect(isFileModuleId(id)).toBe(expected);
  },
);

test('an empty id is not treated as a file', () => {
  // Recorded rather than asserted as desirable: no bundler emits it, and there is
  // no better answer available — an empty id names neither a file nor a package.
  expect(isFileModuleId('')).toBe(false);
});

test.each([
  ['@scope/pkg/deep/path', '@scope/pkg'],
  ['pkg/subpath', 'pkg'],
  ['pkg', 'pkg'],
  ['@scope/pkg', '@scope/pkg'],
])('packageName(%s) is %s', (id, expected) => {
  expect(packageName(id)).toBe(expected);
});

// The regression in full: the bundler asks this exact function whether to leave a
// module as an import. Answering "yes" for a first-party Windows path externalizes
// the whole program, and the build still reports success. This asserts the real
// decision rather than a re-derivation of it, so reverting the predicate at the
// call site cannot leave the suite green.
const INLINED = new Set(['@oxc-project/runtime']);

test.each([
  'C:\\repo\\packages\\zero\\src\\adapters\\kysely.ts',
  'C:/repo/packages/zero/src/adapters/kysely.ts',
  '/repo/packages/zero/src/adapters/kysely.ts',
  './relative.ts',
  '\0virtual:module',
])('bundles the first-party id %s', id => {
  expect(isExternalModuleId(id, INLINED)).toBe(false);
});

test.each(['kysely', 'node:fs', '@rocicorp/logger', 'drizzle-orm/pg-core'])(
  'leaves the third-party id %s external',
  id => {
    expect(isExternalModuleId(id, INLINED)).toBe(true);
  },
);

test.each(['@oxc-project/runtime', '@oxc-project/runtime/helpers/x'])(
  'bundles the inlined package id %s, subpaths included',
  id => {
    expect(isExternalModuleId(id, INLINED)).toBe(false);
  },
);
