import {expect, test} from 'vitest';
import {packageOfRelativePath} from './package-of-path.ts';

// Paths are written with literal separators rather than composed with path.join,
// so each case asserts the same thing on every runner. The regression this
// guards is invisible on POSIX: splitting on '/' is correct there, so only a
// literal backslash path can catch it — and when it regressed, the verification
// this feeds reported success across 975 files while attributing none of them.

test.each([
  ['packages\\zero\\src\\zero.ts', 'packages/zero'],
  ['apps\\zbugs\\src\\main.tsx', 'apps/zbugs'],
  ['tools\\verify-package-deps\\src\\a.ts', 'tools/verify-package-deps'],
])('attributes the Windows path %s to %s', (relativePath, expected) => {
  expect(packageOfRelativePath(relativePath)).toBe(expected);
});

test.each([
  ['packages/zero/src/zero.ts', 'packages/zero'],
  ['apps/zbugs/src/main.tsx', 'apps/zbugs'],
  ['tools/verify-package-deps/src/a.ts', 'tools/verify-package-deps'],
])('attributes the POSIX path %s to %s', (relativePath, expected) => {
  expect(packageOfRelativePath(relativePath)).toBe(expected);
});

test('handles a package directory with no file under it', () => {
  expect(packageOfRelativePath('packages\\zero')).toBe('packages/zero');
});

test.each([
  'scripts\\src\\release.ts',
  'scripts/src/release.ts',
  'prod\\sst\\a.ts',
  'oxlint.base.ts',
  '',
])('returns undefined outside a package root: %s', relativePath => {
  expect(packageOfRelativePath(relativePath)).toBeUndefined();
});

test.each(['packages', 'packages\\', 'packages/'])(
  'a package root with no package under it is not attributed: %s',
  relativePath => {
    // A trailing separator must not read as a package named '': the result is
    // matched against real package names, matches nothing, and the file is then
    // silently exempt from verification rather than reported.
    expect(packageOfRelativePath(relativePath)).toBeUndefined();
  },
);

test.each([
  ['packages//zero/src/a.ts', 'packages/zero'],
  ['packages\\\\zero\\src\\a.ts', 'packages/zero'],
  ['packages/zero//src//a.ts', 'packages/zero'],
])('collapses repeated separators: %s', (relativePath, expected) => {
  // Reachable because the scan root arrives from the environment and needs no
  // normalization to be valid.
  expect(packageOfRelativePath(relativePath)).toBe(expected);
});

test('always reports the package with forward slashes, whatever the input', () => {
  // Callers compare this against package.json-derived names, which are always
  // forward-slashed, so the output separator cannot follow the platform. Both
  // sides are asserted absolutely — comparing the two calls to each other is
  // satisfied by undefined === undefined.
  expect(packageOfRelativePath('packages\\zero\\src\\a.ts')).toBe(
    'packages/zero',
  );
  expect(packageOfRelativePath('packages/zero/src/a.ts')).toBe('packages/zero');
});
