import {expect, test} from 'vitest';
import {packageOfRelativePath} from './package-of-path.ts';

test.each([
  ['packages\\zero\\src\\zero.ts', 'packages/zero'],
  ['apps\\zbugs\\src\\main.tsx', 'apps/zbugs'],
  ['tools\\verify-package-deps\\src\\a.ts', 'tools/verify-package-deps'],
  ['packages/zero/src/zero.ts', 'packages/zero'],
  ['apps/zbugs/src/main.tsx', 'apps/zbugs'],
  ['tools/verify-package-deps/src/a.ts', 'tools/verify-package-deps'],
])('attributes %s to %s', (relativePath, expected) => {
  expect(packageOfRelativePath(relativePath)).toBe(expected);
});

test.each([
  'scripts\\src\\release.ts',
  'scripts/src/release.ts',
  'oxlint.base.ts',
  'packages',
])('attributes %s to no package', relativePath => {
  expect(packageOfRelativePath(relativePath)).toBeUndefined();
});
