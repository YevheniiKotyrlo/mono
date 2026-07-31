import type {execFileSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, expect, test} from 'vitest';
import {
  assertStableZeroVersion,
  assertZeroTagMatchesVersion,
  assertZeroVersion,
  createExec,
  npmZeroVersionExists,
  readReleaseMode,
  resolveNodeShimCommand,
  writeGithubOutput,
  writeZeroPackageVersion,
  zeroTag,
  type Exec,
  type ExecError,
} from './shared.ts';

const originalGithubOutput = process.env.GITHUB_OUTPUT;

afterEach(() => {
  if (originalGithubOutput === undefined) {
    delete process.env.GITHUB_OUTPUT;
  } else {
    process.env.GITHUB_OUTPUT = originalGithubOutput;
  }
});

test('release mode validation accepts known modes', () => {
  expect(readReleaseMode('canary')).toBe('canary');
  expect(readReleaseMode('stable')).toBe('stable');
  expect(readReleaseMode('head')).toBe('head');
  expect(() => readReleaseMode('latest')).toThrowErrorMatchingInlineSnapshot(
    `[Error: Unsupported release mode latest]`,
  );
});

test('zero version and tag validation', () => {
  expect(() => assertZeroVersion('1.2.3')).not.toThrow();
  expect(() => assertZeroVersion('1.2.3-canary.4')).not.toThrow();
  expect(() => assertZeroVersion('1.2.3-head-e8cc6889-20260708')).not.toThrow();
  // An all-digit sha prefix with a leading zero stays valid semver because
  // the hyphen-joined suffix is a single alphanumeric identifier.
  expect(() => assertZeroVersion('1.2.3-head-01234567-20260708')).not.toThrow();
  expect(() => assertZeroVersion('v1.2.3')).toThrowErrorMatchingInlineSnapshot(
    `[Error: Invalid version v1.2.3]`,
  );
  expect(() =>
    assertZeroVersion('1.2.3-head'),
  ).toThrowErrorMatchingInlineSnapshot(`[Error: Invalid version 1.2.3-head]`);
  expect(() =>
    assertZeroVersion('1.2.3-head.202607082153'),
  ).toThrowErrorMatchingInlineSnapshot(
    `[Error: Invalid version 1.2.3-head.202607082153]`,
  );
  expect(() =>
    assertZeroVersion('1.2.3-head-e8cc68-20260708'),
  ).toThrowErrorMatchingInlineSnapshot(
    `[Error: Invalid version 1.2.3-head-e8cc68-20260708]`,
  );
  expect(() =>
    assertZeroVersion('1.2.3-head-e8cc6889-2026'),
  ).toThrowErrorMatchingInlineSnapshot(
    `[Error: Invalid version 1.2.3-head-e8cc6889-2026]`,
  );
  expect(() =>
    assertZeroVersion('1.2.3-beta.1'),
  ).toThrowErrorMatchingInlineSnapshot(`[Error: Invalid version 1.2.3-beta.1]`);

  expect(() => assertStableZeroVersion('1.2.3')).not.toThrow();
  expect(() =>
    assertStableZeroVersion('1.2.3-canary.4'),
  ).toThrowErrorMatchingInlineSnapshot(
    `[Error: Expected stable Zero version, got 1.2.3-canary.4]`,
  );
  expect(() =>
    assertStableZeroVersion('1.2.3-head-e8cc6889-20260708'),
  ).toThrowErrorMatchingInlineSnapshot(
    `[Error: Expected stable Zero version, got 1.2.3-head-e8cc6889-20260708]`,
  );

  expect(zeroTag('1.2.3')).toBe('zero/v1.2.3');
  expect(() =>
    assertZeroTagMatchesVersion('zero/v1.2.3', '1.2.3'),
  ).not.toThrow();
  expect(() =>
    assertZeroTagMatchesVersion('zero/v1.2.4', '1.2.3'),
  ).toThrowErrorMatchingInlineSnapshot(
    `[Error: Tag zero/v1.2.4 does not match version 1.2.3]`,
  );
});

test('writeGithubOutput writes key-value outputs', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'zero-scripts-test-'));
  try {
    const outputPath = join(tempDir, 'github-output');
    process.env.GITHUB_OUTPUT = outputPath;

    writeGithubOutput({tag: 'zero/v1.2.3', version: '1.2.3'});

    expect(readFileSync(outputPath, 'utf8')).toBe(
      'tag=zero/v1.2.3\nversion=1.2.3\n',
    );
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('writeGithubOutput rejects multiline values', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'zero-scripts-test-'));
  try {
    process.env.GITHUB_OUTPUT = join(tempDir, 'github-output');

    expect(() =>
      writeGithubOutput({version: '1.2.3\nmalicious=true'}),
    ).toThrowErrorMatchingInlineSnapshot(
      `[Error: Output version contains a newline]`,
    );
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('writeZeroPackageVersion updates the version in place', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'zero-scripts-test-'));
  try {
    const packageJsonPath = join(tempDir, 'package.json');
    writeFileSync(
      packageJsonPath,
      `${JSON.stringify({name: '@rocicorp/zero', version: '1.8.0'}, null, 2)}\n`,
    );

    const previousVersion = writeZeroPackageVersion(
      '1.8.0-head-e8cc6889-20260708',
      packageJsonPath,
    );

    expect(previousVersion).toBe('1.8.0');
    expect(JSON.parse(readFileSync(packageJsonPath, 'utf8'))).toEqual({
      name: '@rocicorp/zero',
      version: '1.8.0-head-e8cc6889-20260708',
    });
  } finally {
    rmSync(tempDir, {recursive: true, force: true});
  }
});

test('npmZeroVersionExists handles existing and missing npm versions', () => {
  const existing: Exec = () => '1.2.3\n';
  expect(npmZeroVersionExists('1.2.3', existing)).toBe(true);

  const missing: Exec = () => {
    throw missingNpmVersionError();
  };
  expect(npmZeroVersionExists('1.2.3', missing)).toBe(false);
});

test('npmZeroVersionExists surfaces unexpected npm failures', () => {
  const exec: Exec = () => {
    const error = new Error('npm failed') as ExecError;
    error.status = 2;
    error.stderr = Buffer.from('registry unavailable');
    throw error;
  };

  expect(() =>
    npmZeroVersionExists('1.2.3', exec),
  ).toThrowErrorMatchingInlineSnapshot(
    `[Error: Could not check npm for @rocicorp/zero@1.2.3: registry unavailable]`,
  );
});

function missingNpmVersionError() {
  const error = new Error('missing') as ExecError;
  error.status = 1;
  error.stderr = Buffer.from('');
  return error;
}

// resolveNodeShimCommand: platform is injected rather than read from the host,
// so the Windows behaviour is covered on a POSIX CI runner too. Without that
// the npm-on-Windows defect is untestable anywhere it does not already occur.
test('resolveNodeShimCommand leaves npm alone on posix', () => {
  const resolved = resolveNodeShimCommand('npm', ['pack'], 'linux', () => true);
  expect(resolved).toEqual({command: 'npm', args: ['pack']});
});

test('resolveNodeShimCommand runs npm under node on win32', () => {
  const probed: string[] = [];
  const resolved = resolveNodeShimCommand(
    'npm',
    ['pack', '--json'],
    'win32',
    path => {
      probed.push(path);
      return true;
    },
  );
  expect(resolved.command).toBe(process.execPath);
  expect(resolved.args.slice(1)).toEqual(['pack', '--json']);
  // The full expected path, not a suffix match: the location is the whole point,
  // and a suffix match would accept npm-cli.js resolved from anywhere.
  const expectedCli = join(
    dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  expect(resolved.args[0]).toBe(expectedCli);
  expect(probed).toEqual([expectedCli]);
});

test('resolveNodeShimCommand throws when npm is not beside node on win32', () => {
  // Never fall back to the bare name: that is the invocation this exists to
  // avoid, and its ENOENT names neither npm nor this decision.
  expect(() =>
    resolveNodeShimCommand('npm', ['pack'], 'win32', () => false),
  ).toThrow(/npm-cli\.js/);
});

test('the exec chokepoint routes through resolveNodeShimCommand', () => {
  // The command has to be one whose resolution actually differs, or the
  // assertion holds whether the routing happened or not — which is why the
  // platform is injected rather than read from the host.
  const calls: {command: string; args: readonly string[]}[] = [];
  const exec = createExec({
    execFile: ((command: string, args: readonly string[]) => {
      calls.push({command, args});
      return '';
    }) as unknown as typeof execFileSync,
    platform: 'win32',
    fileExists: () => true,
  });

  exec('npm', ['pack', '--json'], {});

  const expectedCli = join(
    dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  expect(calls).toEqual([
    {command: process.execPath, args: [expectedCli, 'pack', '--json']},
  ]);
});

test('the exec chokepoint leaves a real executable alone', () => {
  const calls: {command: string; args: readonly string[]}[] = [];
  const exec = createExec({
    execFile: ((command: string, args: readonly string[]) => {
      calls.push({command, args});
      return '';
    }) as unknown as typeof execFileSync,
    platform: 'win32',
  });

  exec('git', ['status'], {});
  expect(calls).toEqual([{command: 'git', args: ['status']}]);
});

test.each(['docker', 'git', 'tar'] as const)(
  'resolveNodeShimCommand leaves %s untouched on win32 — it is a real executable',
  command => {
    expect(
      resolveNodeShimCommand(command, ['--version'], 'win32', () => true),
    ).toEqual({
      command,
      args: ['--version'],
    });
  },
);
