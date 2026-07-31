import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, expect, test} from 'vitest';

/**
 * Smoke tests for the verification itself, not its helpers.
 *
 * The unit tests next door cover the predicate that attributes a file to a
 * package. They cannot catch the failure that actually happened: the predicate
 * returning undefined for everything, so nothing was attributed, so no import
 * was ever checked and the run reported success over 975 files. A gate that
 * cannot fail is worse than no gate, and only running it against known-bad input
 * proves it still can.
 */

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  'verify-package-deps.ts',
);

const fixtureRoots: string[] = [];

afterEach(() => {
  // Each case writes a workspace to run the real gate against; without this they
  // accumulate in the temp directory for the life of the machine.
  for (const root of fixtureRoots.splice(0)) {
    rmSync(root, {recursive: true, force: true});
  }
});

/**
 * Builds a throwaway workspace with two packages where `alpha` imports across
 * into `beta`. `betaDeclared` decides whether alpha declares that dependency,
 * which is the difference between a clean run and a reported violation.
 */
function makeFixture(betaDeclared: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-deps-smoke-'));
  fixtureRoots.push(root);
  // The gate refuses a --root that is not a workspace, so the fixture declares
  // itself one.
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
  );
  // All three roots must exist: the scan reads each one directly.
  for (const dir of ['packages', 'apps', 'tools']) {
    mkdirSync(join(root, dir), {recursive: true});
  }

  const alpha = join(root, 'packages', 'alpha');
  const beta = join(root, 'packages', 'beta');
  mkdirSync(join(alpha, 'src'), {recursive: true});
  mkdirSync(join(beta, 'src'), {recursive: true});

  writeFileSync(
    join(alpha, 'package.json'),
    `${JSON.stringify(
      {
        name: 'alpha',
        version: '0.0.0',
        private: true,
        ...(betaDeclared ? {dependencies: {beta: '0.0.0'}} : {}),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(beta, 'package.json'),
    `${JSON.stringify({name: 'beta', version: '0.0.0', private: true}, null, 2)}\n`,
  );

  writeFileSync(join(beta, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(
    join(alpha, 'src', 'a.ts'),
    "import {b} from '../../beta/src/b.ts';\nexport const a = b;\n",
  );

  return root;
}

function runVerification(
  root: string,
  spelling: 'separate' | 'inline' = 'separate',
): {status: number; output: string} {
  const rootArgs =
    spelling === 'inline' ? [`--root=${root}`] : ['--root', root];
  const result = spawnSync(process.execPath, [SCRIPT, ...rootArgs], {
    encoding: 'utf8',
  });
  if (result.error) {
    // Otherwise a failure to start the gate at all reports as an assertion about
    // missing output, which names neither the spawn nor the cause.
    throw new Error(`Could not run ${SCRIPT}`, {cause: result.error});
  }
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

test('reports a cross-package import that is not declared', () => {
  const {status, output} = runVerification(makeFixture(false));

  // The assertion that matters: a real violation is found and the run fails.
  // When attribution was broken this exited 0 with "All internal dependencies
  // are properly declared".
  expect(output).toContain('packages/alpha');
  expect(output).toContain('beta');
  expect(status).not.toBe(0);
});

test('passes when the same import is declared', () => {
  const {status, output} = runVerification(makeFixture(true));

  expect(output).toContain('properly declared');
  expect(status).toBe(0);
});

test('honours --root=<dir> as well as --root <dir>', () => {
  // Recognising only the separated form would make `--root=<dir>` fall back to the
  // real repository — and with --fix that rewrites the manifests the operator
  // believed they had pointed away from.
  const {status, output} = runVerification(makeFixture(false), 'inline');
  expect(output).toContain('packages/alpha');
  expect(status).not.toBe(0);
});

test.each([
  [
    'separate then inline',
    (a: string, b: string) => ['--root', a, `--root=${b}`],
  ],
  [
    'inline then separate',
    (a: string, b: string) => [`--root=${a}`, '--root', b],
  ],
])('the last --root wins, %s', (_name, args) => {
  // Preferring one spelling over the other made `--root=/repo --root /fixture`
  // choose /repo whatever the order — and with --fix that rewrites the manifests
  // the operator had pointed away from.
  const ignored = makeFixture(true);
  const chosen = makeFixture(false);
  const result = spawnSync(
    process.execPath,
    [SCRIPT, ...args(ignored, chosen)],
    {encoding: 'utf8'},
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  expect(output).toContain('packages/alpha');
  expect(result.status).not.toBe(0);
});

test.each([['--root'], ['--root='], ['--root', '--fix']])(
  'rejects a --root with no usable value: %s',
  (...args: string[]) => {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(
      '--root requires a directory',
    );
  },
);

test('refuses a --root that is not a workspace', () => {
  const notAWorkspace = mkdtempSync(join(tmpdir(), 'verify-deps-notws-'));
  fixtureRoots.push(notAWorkspace);
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--root', notAWorkspace],
    {
      encoding: 'utf8',
    },
  );
  expect(result.status).not.toBe(0);
  expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(
    'not a workspace root',
  );
});

test('refuses an empty --root rather than scanning the cwd', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', ''], {
    encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain(
    '--root requires a directory',
  );
});

test('attributes the violation to a package rather than reporting none', () => {
  const {output} = runVerification(makeFixture(false));

  // Distinguishes "found nothing to check" from "checked and found nothing
  // wrong" — the two were indistinguishable in the output before.
  expect(output).toMatch(/Found \d+ TypeScript files to analyze/);
  expect(output).not.toContain(
    'All internal dependencies are properly declared',
  );
});
