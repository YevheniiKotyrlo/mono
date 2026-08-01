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

/** Suite-level `{timeout: N}` options, which apply to every case in the file. */
function suiteTimeouts(source: string): number[] {
  return Array.from(
    source.matchAll(/\bdescribe\([^,]+,\s*\{[^}]*timeout:\s*([\d_]+)/gu),
    match => Number(match[1].replaceAll('_', '')),
  ).filter(value => Number.isFinite(value));
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
});
