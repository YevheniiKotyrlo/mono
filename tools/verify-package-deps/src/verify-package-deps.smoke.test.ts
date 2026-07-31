import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

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

/**
 * Builds a throwaway workspace with two packages where `alpha` imports across
 * into `beta`. `betaDeclared` decides whether alpha declares that dependency,
 * which is the difference between a clean run and a reported violation.
 */
function makeFixture(betaDeclared: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'verify-deps-smoke-'));
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

function runVerification(root: string): {status: number; output: string} {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], {
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

test('attributes the violation to a package rather than reporting none', () => {
  const {output} = runVerification(makeFixture(false));

  // Distinguishes "found nothing to check" from "checked and found nothing
  // wrong" — the two were indistinguishable in the output before.
  expect(output).toMatch(/Found \d+ TypeScript files to analyze/);
  expect(output).not.toContain(
    'All internal dependencies are properly declared',
  );
});
