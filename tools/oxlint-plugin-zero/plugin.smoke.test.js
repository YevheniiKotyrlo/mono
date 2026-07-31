import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

/**
 * Smoke tests for the rules as the linter runs them, not for their predicates.
 *
 * The unit tests next door cover the predicates directly. They cannot catch the
 * failure that actually happened: no-select-star's include prefixes never
 * matched, so the rule quietly did not run and the only symptom was an
 * "unused disable directive" elsewhere. A rule that cannot report is
 * indistinguishable from a clean codebase, so each rule is exercised end to end
 * against known-bad input.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, 'index.js');
const OXLINT = join(
  HERE,
  '..',
  '..',
  'node_modules',
  'oxlint',
  'bin',
  'oxlint',
);

/** Writes a fixture file plus a config enabling only this plugin's rules. */
function lintFixture(relativeFilePath, source, ruleName, ruleOptions) {
  const root = mkdtempSync(join(tmpdir(), 'zero-plugin-smoke-'));
  const filePath = join(root, relativeFilePath);
  mkdirSync(dirname(filePath), {recursive: true});
  writeFileSync(filePath, source);

  writeFileSync(
    join(root, '.oxlintrc.json'),
    JSON.stringify({
      plugins: ['eslint', 'typescript'],
      jsPlugins: [PLUGIN],
      categories: {
        correctness: 'off',
        suspicious: 'off',
        pedantic: 'off',
        style: 'off',
        restriction: 'off',
        nursery: 'off',
        perf: 'off',
      },
      rules: {
        [ruleName]:
          ruleOptions === undefined ? 'error' : ['error', ruleOptions],
      },
    }),
  );

  const result = spawnSync(process.execPath, [OXLINT, '.'], {
    cwd: root,
    encoding: 'utf8',
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

test('no-select-star reports SELECT * inside an included path', () => {
  const output = lintFixture(
    join('packages', 'zero-cache', 'src', 'query.ts'),
    'const sql = `SELECT * FROM issues`;\nexport default sql;\n',
    'zero/no-select-star',
    {include: ['packages/zero-cache/src/']},
  );

  // The regression this guards: the include prefix stopped matching, the rule
  // silently did not run, and the lint reported a clean file.
  expect(output).toContain('no-select-star');
});

test('no-select-star stays quiet outside the included paths', () => {
  const output = lintFixture(
    join('packages', 'other', 'src', 'query.ts'),
    'const sql = `SELECT * FROM issues`;\nexport default sql;\n',
    'zero/no-select-star',
    {include: ['packages/zero-cache/src/']},
  );

  expect(output).not.toContain('no-select-star');
});

test('no-file-url-pathname reports a file URL used as a path', () => {
  const output = lintFixture(
    join('packages', 'thing', 'src', 'a.ts'),
    "const p = new URL('./x.js', import.meta.url).pathname;\nexport default p;\n",
    'zero/no-file-url-pathname',
  );

  expect(output).toContain('no-file-url-pathname');
});

test('no-file-url-pathname leaves a real URL alone', () => {
  const output = lintFixture(
    join('packages', 'thing', 'src', 'a.ts'),
    "const p = new URL('https://example.com/a').pathname;\nexport default p;\n",
    'zero/no-file-url-pathname',
  );

  expect(output).not.toContain('no-file-url-pathname');
});

test('no-bare-shim-spawn reports spawning a shim command by bare name', () => {
  const output = lintFixture(
    join('packages', 'thing', 'src', 'a.ts'),
    "import {spawn} from 'node:child_process';\nspawn('tsc', ['-p', 'tsconfig.json'], {stdio: 'inherit'});\n",
    'zero/no-bare-shim-spawn',
  );

  expect(output).toContain('no-bare-shim-spawn');
});

test('no-bare-shim-spawn leaves a real executable alone', () => {
  const output = lintFixture(
    join('packages', 'thing', 'src', 'a.ts'),
    "import {spawn} from 'node:child_process';\nspawn('git', ['--version'], {stdio: 'inherit'});\n",
    'zero/no-bare-shim-spawn',
  );

  expect(output).not.toContain('no-bare-shim-spawn');
});
