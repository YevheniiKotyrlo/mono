import {expect, test} from 'vitest';
import {isFileModuleId} from './build.ts';

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

// The regression in full: a bundler asks "is this a file?" to decide whether to
// bundle. Answering "no" for a first-party Windows path externalizes everything.
test('a Windows entry path is bundled, not externalized', () => {
  const entry = 'C:\\repo\\packages\\zero\\src\\adapters\\kysely.ts';
  const inlined = new Set(['@oxc-project/runtime']);
  const isExternal = (id: string) => !isFileModuleId(id) && !inlined.has(id);

  expect(isExternal(entry)).toBe(false);
  // A genuine third-party import stays external in the same breath.
  expect(isExternal('kysely')).toBe(true);
  expect(isExternal('@oxc-project/runtime')).toBe(false);
});
