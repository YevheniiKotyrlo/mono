import {readFileSync} from 'node:fs';
import {readdirSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';
import {MAX_PG_TEST_TIMEOUT_MS} from '../../../shared/src/tool/vitest-config.ts';

/**
 * A Postgres-backed suite may raise its own time budget, never lower it.
 *
 * The project grants one that already accounts for where it runs — doubled in CI,
 * because CI is slower. A file that hardcodes its own number opts out of that: a
 * literal equal to the local grant silently halves the CI one, and a smaller
 * literal halves both. Neither is visible at the call site, and what it produces
 * is a suite that passes alone and times out under the parallelism the pg projects
 * actually run at. Four files had one, and the case that finally exposed the
 * pattern ran in under a second on its own while failing at ten.
 *
 * Raising is fine and stays possible — a suite that genuinely needs longer than
 * its siblings can say so, and saying so is the point. This only refuses the
 * direction that can turn a healthy test red.
 *
 * A tight budget used as a DETECTOR belongs on the case that detects with it, not
 * on the file: see the crafted COPY case in initial-sync.pg.test.ts, whose
 * documented failure mode is an unresponsive Postgres and which therefore reports
 * as a timeout by design.
 */

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** Every `*.pg.test.ts` in the repo. */
function pgTestFiles(): string[] {
  const found: string[] = [];
  const search = (dir: string) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        search(path);
      } else if (entry.name.endsWith('.pg.test.ts')) {
        found.push(path);
      }
    }
  };
  for (const top of ['packages', 'apps']) {
    search(join(REPO_ROOT, top));
  }
  return found;
}

/**
 * Lines that open a suite AND carry a time budget in its options object.
 *
 * Found loosely on purpose. The value is read by a precise pattern below, and a
 * candidate that pattern cannot read is reported rather than skipped — otherwise
 * the matcher decides what counts as a violation, which is how the first version
 * of this went blind: it anchored on `describe(` and so could never see
 * `describe.skipIf(!RUN)('…', {timeout: 30000}`, which is exactly the shape a
 * suite takes once it moves behind an opt-in flag.
 */
function suiteTimeoutCandidates(
  source: string,
): {line: number; text: string}[] {
  return source
    .split('\n')
    .map((text, index) => ({line: index + 1, text}))
    .filter(
      ({text}) => /\bdescribe\b/u.test(text) && /\{[^}]*\btimeout:/u.test(text),
    );
}

/** Any modifier chain is allowed between `describe` and its arguments. */
const SUITE_TIMEOUT =
  /\bdescribe(?:\.\w+)*(?:\([^()]*\))?\(\s*[^,]+,\s*\{[^}]*timeout:\s*([\d_]+)/u;

/** Suite-level `{timeout: N}` options, which apply to every case in the file. */
function suiteTimeouts(source: string): number[] {
  return suiteTimeoutCandidates(source).flatMap(({text}) => {
    const value = Number(SUITE_TIMEOUT.exec(text)?.[1].replaceAll('_', ''));
    return Number.isFinite(value) ? [value] : [];
  });
}

/** Candidates the precise pattern could not read — a blind spot, not a pass. */
function unreadSuiteTimeouts(source: string): string[] {
  return suiteTimeoutCandidates(source)
    .filter(({text}) => !SUITE_TIMEOUT.test(text))
    .map(({line, text}) => `${line}: ${text.trim()}`);
}

const files = pgTestFiles();

/**
 * Compared against the maximum the project ever grants, not against this run's.
 *
 * The grant doubles in CI because CI is slower, so a literal equal to the local
 * value is below the CI value — and a check that reads the environment it runs in
 * passes locally on exactly the literals that undercut CI. The first pass of this
 * gate did that, and let a `{timeout: 30000}` through.
 */
const granted = MAX_PG_TEST_TIMEOUT_MS;

test('the pg test files are found at all', () => {
  // Otherwise the case below passes over an empty list and proves nothing.
  expect(files.length).toBeGreaterThan(20);
});

test('no pg suite lowers the budget its project grants', () => {
  const lowered: string[] = [];
  for (const file of files) {
    for (const timeout of suiteTimeouts(readFileSync(file, 'utf8'))) {
      if (timeout < granted) {
        lowered.push(
          `${relative(REPO_ROOT, file).replaceAll('\\', '/')}: ${timeout}ms < ${granted}ms`,
        );
      }
    }
  }
  expect(lowered).toEqual([]);
});

/** Every `vitest.config*.ts` under a package, where projects are assembled. */
function packageConfigs(): string[] {
  const found: string[] = [];
  const search = (dir: string, depth: number) => {
    if (depth > 3) {
      return;
    }
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
        continue;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        search(path, depth + 1);
      } else if (/^vitest\.config.*\.ts$/u.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const top of ['packages', 'apps']) {
    search(join(REPO_ROOT, top), 0);
  }
  return found;
}

test('no config lowers a pg project’s budget on its way past', () => {
  // The suite-level check above reads test FILES. A project's budget can also be
  // cut where the project is assembled — `mergeConfig(configForVersion(16, url),
  // {test: {testTimeout: 20_000}})` overrides the shared grant, and no test file
  // says anything about it. One package did exactly that across every project it
  // owned, which raised its no-pg budget (10s -> 20s, deliberate) and quietly
  // lowered all four pg ones (60s -> 20s in CI, not deliberate at all).
  //
  // A raise scoped to the no-pg project is the legitimate shape, so the target of
  // the merge is what decides: overriding `configForNoPg` is fine, overriding
  // `configForVersion` is not.
  const lowered: string[] = [];
  for (const config of packageConfigs()) {
    const source = readFileSync(config, 'utf8');
    for (const match of source.matchAll(
      /mergeConfig\(\s*(\w+)\([^)]*\)\s*,\s*\{[^}]*testTimeout:\s*([\d_]+)/gu,
    )) {
      const [, target, literal] = match;
      const value = Number(literal.replaceAll('_', ''));
      if (target !== 'configForNoPg' && value < granted) {
        lowered.push(
          `${relative(REPO_ROOT, config).replaceAll('\\', '/')}: ` +
            `${target} merged down to ${value}ms < ${granted}ms`,
        );
      }
    }
  }
  expect(lowered).toEqual([]);
});

test('the config scan finds the shape it is looking for', () => {
  // A tripwire on the pattern: it has to see both the legitimate no-pg raise and
  // the pg lowering, or the case above passes because the regex matched nothing.
  expect(packageConfigs().length).toBeGreaterThan(8);
  const seen = packageConfigs().some(config =>
    /mergeConfig\(\s*configForNoPg\([^)]*\)\s*,\s*\{[^}]*testTimeout:/u.test(
      readFileSync(config, 'utf8'),
    ),
  );
  expect(seen).toBe(true);
});

test('the granted budget is a real one', () => {
  // A tripwire on the comparison itself: were the grant zero or missing, every
  // literal would clear it and the case above would pass vacuously.
  expect(granted).toBeGreaterThanOrEqual(10_000);
  // And it is the CI grant, not the local one.
  expect(granted).toBe(60_000);
});

test('the scan reads a suite timeout where one exists', () => {
  // And a tripwire on the matcher: a regex that matched nothing would report no
  // violations however many there were.
  expect(suiteTimeouts("describe('x', {timeout: 15000}, () => {}); ")).toEqual([
    15000,
  ]);
  expect(suiteTimeouts("describe('x', {timeout: 20_000}, () => {});")).toEqual([
    20000,
  ]);
  expect(suiteTimeouts("describe('x', () => {});")).toEqual([]);
  // Modifier chains, which is what a suite behind an opt-in flag looks like.
  expect(
    suiteTimeouts("describe.skipIf(!RUN)('x', {timeout: 30000}, () => {});"),
  ).toEqual([30000]);
  expect(
    suiteTimeouts("describe.skip('x', {timeout: 25000}, () => {});"),
  ).toEqual([25000]);
});

test('no suite timeout escapes the matcher', () => {
  // The matcher cannot also be the thing that decides what counts. A line that
  // opens a suite and carries a timeout, but that the precise pattern cannot
  // read, fails here rather than passing silently.
  const unread = files.flatMap(file =>
    unreadSuiteTimeouts(readFileSync(file, 'utf8')).map(
      hit => `${relative(REPO_ROOT, file).replaceAll('\\', '/')}:${hit}`,
    ),
  );
  expect(unread).toEqual([]);
});

test('an unreadable candidate is reported rather than skipped', () => {
  // Proof the case above can fire. The candidate finder over-approximates on
  // purpose, so it also flags a line that merely mentions both — and that is the
  // trade it is making: an over-approximation nobody can read is surfaced for a
  // human to judge, rather than a matcher quietly deciding a suite has no budget.
  // No such line exists in the repo, which is why the case above is green.
  expect(
    unreadSuiteTimeouts('describe(name, options); // {timeout: 5000}'),
  ).toHaveLength(1);
  expect(
    unreadSuiteTimeouts("describe('x', {timeout: 5000}, () => {});"),
  ).toEqual([]);
  // Modifier chains are read, so they are never reported as unreadable.
  expect(
    unreadSuiteTimeouts(
      "describe.skipIf(!RUN)('x', {timeout: 5000}, () => {});",
    ),
  ).toEqual([]);
});
