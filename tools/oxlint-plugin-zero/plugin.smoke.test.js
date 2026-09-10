import {spawnSync} from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, expect, test} from 'vitest';

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

/**
 * Where oxlint's CLI actually lives, resolved through its manifest.
 *
 * Not a hardcoded hop into the root node_modules: that assumes a hoisted layout,
 * which a filtered install does not give. Not `resolve('oxlint/bin/oxlint')`
 * either — oxlint has an `exports` map that does not list that subpath, so
 * requesting it directly throws ERR_PACKAGE_PATH_NOT_EXPORTED. `./package.json`
 * is exported, and its `bin` says where the entry is.
 */
function resolveOxlint() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('oxlint/package.json');
  const {bin} = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof bin === 'string' ? bin : bin?.oxlint;
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new Error(`no usable oxlint bin in ${manifestPath}`);
  }
  const packageDir = dirname(manifestPath);
  const resolved = resolve(packageDir, entry);
  if (!resolved.startsWith(packageDir)) {
    throw new Error(`oxlint bin points outside its package: ${entry}`);
  }
  return resolved;
}

const OXLINT = resolveOxlint();

/** A built-in rule and a file that violates it, proving the harness can lint. */
const CANARY_RULE = 'no-debugger';
const CANARY_FILE = '__canary.ts';

const fixtureRoots = [];

afterEach(() => {
  // Each case writes a workspace to run the real linter against; without this
  // they accumulate in the temp directory for the life of the machine.
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, {recursive: true, force: true});
  }
});

/** Writes a fixture file plus a config enabling only this plugin's rules. */
function lintFixture(relativeFilePath, source, ruleName, ruleOptions) {
  const root = mkdtempSync(join(tmpdir(), 'zero-plugin-smoke-'));
  fixtureRoots.push(root);
  const filePath = join(root, relativeFilePath);
  mkdirSync(dirname(filePath), {recursive: true});
  writeFileSync(filePath, source);

  // A file that always violates a built-in rule, at WARNING level so it never
  // moves the exit code the assertions below read. Its diagnostic is the proof
  // that oxlint reached this fixture at all.
  writeFileSync(
    join(root, CANARY_FILE),
    'debugger;\nexport const canary = 1;\n',
  );

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
        [CANARY_RULE]: 'warn',
        [ruleName]:
          ruleOptions === undefined ? 'error' : ['error', ruleOptions],
      },
    }),
  );

  const result = spawnSync(process.execPath, [OXLINT, '.'], {
    cwd: root,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

  // A harness that cannot lint would satisfy every "does not report" assertion
  // below — a plugin that fails to load, a rejected config, a wrong oxlint path.
  // So each run proves it actually linted the fixture before its own assertion
  // is allowed to mean anything. This is the same failure the rule under test
  // had (silence is indistinguishable from clean), reintroduced one level up.
  //
  // The canary's own diagnostic is the proof, rather than oxlint's summary line:
  // that line is prose, it is not emitted for every invocation, and keying a
  // correctness guard on it turns an oxlint upgrade into a suite that passes
  // while checking nothing.
  if (!output.includes(CANARY_RULE)) {
    throw new Error(
      `oxlint did not lint the fixture (status ${result.status}):\n${output}`,
    );
  }
  return {output, status: result.status};
}

/** Asserts the rule fired on a fixture that violates it. */
function expectReported(result, ruleName) {
  expect(result.output).toContain(ruleName);
  expect(result.status).not.toBe(0);
}

/** Asserts the rule stayed silent on a fixture that does not violate it. */
function expectSilent(result, ruleName) {
  expect(result.output).not.toContain(ruleName);
  expect(result.status).toBe(0);
}

test('no-select-star reports SELECT * inside an included path', () => {
  const result = lintFixture(
    join('packages', 'zero-cache', 'src', 'query.ts'),
    'const sql = `SELECT * FROM issues`;\nexport default sql;\n',
    'zero/no-select-star',
    {include: ['packages/zero-cache/src/']},
  );

  // The regression this guards: the include prefix stopped matching, the rule
  // silently did not run, and the lint reported a clean file.
  expectReported(result, 'no-select-star');
});

test('no-select-star stays quiet outside the included paths', () => {
  const result = lintFixture(
    join('packages', 'other', 'src', 'query.ts'),
    'const sql = `SELECT * FROM issues`;\nexport default sql;\n',
    'zero/no-select-star',
    {include: ['packages/zero-cache/src/']},
  );

  expectSilent(result, 'no-select-star');
});

test('no-file-url-pathname reports a file URL used as a path', () => {
  const result = lintFixture(
    join('packages', 'thing', 'src', 'a.ts'),
    "const p = new URL('./x.js', import.meta.url).pathname;\nexport default p;\n",
    'zero/no-file-url-pathname',
  );

  expectReported(result, 'no-file-url-pathname');
});

test('no-file-url-pathname leaves a real URL alone', () => {
  const result = lintFixture(
    join('packages', 'thing', 'src', 'a.ts'),
    "const p = new URL('https://example.com/a').pathname;\nexport default p;\n",
    'zero/no-file-url-pathname',
  );

  expectSilent(result, 'no-file-url-pathname');
});

test('no-bare-shim-spawn reports spawning a shim command by bare name', () => {
  const result = lintFixture(
    join('packages', 'thing', 'src', 'a.ts'),
    "import {spawn} from 'node:child_process';\nspawn('tsc', ['-p', 'tsconfig.json'], {stdio: 'inherit'});\n",
    'zero/no-bare-shim-spawn',
  );

  expectReported(result, 'no-bare-shim-spawn');
});

test('no-bare-shim-spawn leaves a real executable alone', () => {
  const result = lintFixture(
    join('packages', 'thing', 'src', 'a.ts'),
    "import {spawn} from 'node:child_process';\nspawn('git', ['--version'], {stdio: 'inherit'});\n",
    'zero/no-bare-shim-spawn',
  );

  expectSilent(result, 'no-bare-shim-spawn');
});
