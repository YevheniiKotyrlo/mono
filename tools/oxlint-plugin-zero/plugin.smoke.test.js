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
const REPOSITORY = resolve(HERE, '..', '..');

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

const temporaryRoots = [];

afterEach(() => {
  // Each case writes a workspace or a config to run the real linter with;
  // without this they accumulate in the temp directory for the life of the
  // machine.
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, {recursive: true, force: true});
  }
});

/**
 * Writes `.oxlintrc.json` into `directory`, loading this plugin with only `rule`
 * enabled, as `ruleConfig`, and returns its path.
 */
function writeRuleConfig(directory, rule, ruleConfig) {
  const path = join(directory, '.oxlintrc.json');
  writeFileSync(
    path,
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
        [rule]: ruleConfig,
      },
    }),
  );
  return path;
}

/**
 * Runs oxlint in `cwd` with `args`, and returns its exit status, its JSON
 * report, and the diagnostics `rule` raised in it.
 */
function runOxlint(cwd, args, rule) {
  const result = spawnSync(
    process.execPath,
    [OXLINT, ...args, '--format=json'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  let report;
  try {
    report = JSON.parse(result.stdout ?? '');
  } catch (cause) {
    throw new Error(
      `oxlint did not emit a JSON report (status ${result.status}): ` +
        `${result.stdout ?? ''}${result.stderr ?? ''}`,
      {cause},
    );
  }
  const code = `zero(${rule.slice('zero/'.length)})`;
  const diagnostics = (report.diagnostics ?? []).filter(
    diagnostic => diagnostic.code === code,
  );
  return {status: result.status, report, diagnostics};
}

const posixFilename = diagnostic => diagnostic.filename.replaceAll('\\', '/');

/**
 * Lints `files` (path relative to the fixture root -> source) with only `rule`
 * enabled, as `ruleConfig`. Returns the exit status and the files the rule
 * reported, as POSIX paths.
 */
function lintFixture(rule, ruleConfig, files) {
  const root = mkdtempSync(join(tmpdir(), 'zero-plugin-smoke-'));
  temporaryRoots.push(root);
  for (const [relativePath, source] of Object.entries(files)) {
    const filePath = join(root, relativePath);
    mkdirSync(dirname(filePath), {recursive: true});
    writeFileSync(filePath, source);
  }
  writeRuleConfig(root, rule, ruleConfig);

  const {status, diagnostics} = runOxlint(root, ['.'], rule);
  return {status, reported: diagnostics.map(posixFilename)};
}

/**
 * Lints this repository with only `rule` enabled, as `ruleConfig`: every file
 * git does not ignore, with neither the repository's ignore patterns nor its
 * nested configs, so a directory its lint config leaves out is still read.
 * Returns how many files were linted and each report as `path:line`.
 */
function lintRepository(rule, ruleConfig) {
  const configRoot = mkdtempSync(join(tmpdir(), 'zero-plugin-repository-'));
  temporaryRoots.push(configRoot);
  const config = writeRuleConfig(configRoot, rule, ruleConfig);

  const {report, diagnostics} = runOxlint(
    REPOSITORY,
    ['-c', config, '--disable-nested-config', '.'],
    rule,
  );
  return {
    files: report.number_of_files,
    reported: diagnostics.map(
      diagnostic =>
        `${posixFilename(diagnostic)}:${diagnostic.labels?.[0]?.span?.line}`,
    ),
  };
}

const selectStar = 'const sql = `SELECT * FROM issues`;\nexport default sql;\n';

test('no-select-star reports SELECT * inside the included paths, and only there', () => {
  const {status, reported} = lintFixture(
    'zero/no-select-star',
    ['error', {include: ['packages/zero-cache/src/']}],
    {
      'packages/zero-cache/src/query.ts': selectStar,
      'packages/other/src/query.ts': selectStar,
    },
  );

  // The in-scope file is the canary for the out-of-scope one: its report proves
  // the plugin loaded and ran in this same run, so the other file's silence
  // comes from the include prefix and not from a plugin that never loaded. On
  // Windows the in-scope half is also the regression test: the prefix did not
  // match backslash paths, so the rule reported nothing anywhere.
  expect(reported).toEqual(['packages/zero-cache/src/query.ts']);
  expect(status).not.toBe(0);
});

const spawnVersion = command =>
  `import {spawnSync} from 'node:child_process';\n` +
  `export const result = spawnSync('${command}', ['--version']);\n`;

test('no-bare-shim-spawn reports a shim spawned by bare name, and not an executable', () => {
  const {status, reported} = lintFixture('zero/no-bare-shim-spawn', 'error', {
    'npm.ts': spawnVersion('npm'),
    'git.ts': spawnVersion('git'),
  });

  // As above, the reported file proves the rule loaded and ran in this run, so
  // the other file's silence comes from the rule and not from a missing plugin.
  expect(reported).toEqual(['npm.ts']);
  expect(status).not.toBe(0);
});

const testBody = statements =>
  `import {expect, test} from 'vitest';\n\n` +
  `test('case', () => {\n  ${statements.join('\n  ')}\n});\n`;

test('no-unasserted-expect reports an expect() that asserts nothing, and not one that asserts', () => {
  const {status, reported} = lintFixture('zero/no-unasserted-expect', 'error', {
    'no-matcher.test.ts': testBody(['expect(1 > 0);']),
    'uncalled.test.ts': testBody(['expect(1).toBeDefined;']),
    'asserted.test.ts': testBody([
      'expect(1).toBe(1);',
      'expect(true).to.be.true;',
    ]),
  });

  // As above, the two reports prove the rule ran, so the asserting file's
  // silence comes from the rule.
  expect(reported.toSorted()).toEqual([
    'no-matcher.test.ts',
    'uncalled.test.ts',
  ]);
  expect(status).not.toBe(0);
});

test('the repository has no expect() that asserts nothing', () => {
  const {files, reported} = lintRepository(
    'zero/no-unasserted-expect',
    'error',
  );

  // A scan that reached nothing would pass by checking nothing.
  expect(files).toBeGreaterThan(500);
  expect(reported).toEqual([]);
});
