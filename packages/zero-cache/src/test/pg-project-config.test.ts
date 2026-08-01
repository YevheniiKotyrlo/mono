import {readFileSync} from 'node:fs';
import {readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';
import {
  maxConcurrentPgFiles,
  PG_PROJECT_GROUP_ORDER,
  pgProjectDefaults,
} from '../../../shared/src/tool/vitest-config.ts';
import {configForNoPg, configForVersion} from '../../vitest.config.ts';

/**
 * Every Postgres-backed project has to agree on how many files run at once.
 *
 * Not a preference: vitest refuses to run projects that sit in one
 * `sequence.groupOrder` and disagree on `maxWorkers`, and it reports that as
 * "Projects X and Y have different 'maxWorkers'" with no hint of why they should
 * match. A project that builds its own config instead of spreading the shared
 * defaults is the way that happens, so this looks for exactly that — while the
 * fast suite is running, rather than the first time somebody runs the pg ones.
 */

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** Every config that defines a pg project, wherever it lives. */
function pgProjectConfigs(): string[] {
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
      } else if (/^vitest\.config\.pg-\d+\.ts$/u.test(entry.name)) {
        found.push(path);
      }
    }
  };
  for (const top of ['packages', 'apps']) {
    search(join(REPO_ROOT, top), 0);
  }
  return found;
}

const configs = pgProjectConfigs();

test('the pg projects are discovered at all', () => {
  // Otherwise the case below passes over an empty list and proves nothing.
  expect(configs.length).toBeGreaterThan(4);
});

test('every pg project builds on the shared defaults', () => {
  // They all delegate to a `configForVersion`, and there are two of those — one
  // for packages and one for apps. Both must spread `pgProjectDefaults`, because
  // that is what makes their `maxWorkers` equal by construction rather than by
  // somebody remembering.
  // Collected and asserted as a list, so a failure names every offender at once
  // rather than stopping at the first — and so the diff carries the path without
  // needing a per-assertion message.
  const standalone: string[] = [];
  const builders = new Set<string>();
  for (const config of configs) {
    const source = readFileSync(config, 'utf8');
    const importedFrom = /from '([^']*vitest\.config\.ts)'/u.exec(source);
    if (importedFrom === null) {
      standalone.push(`${config} does not delegate to a configForVersion`);
      continue;
    }
    builders.add(join(dirname(config), importedFrom[1]));
  }
  expect(standalone).toEqual([]);

  expect(builders.size).toBeGreaterThan(0);
  const undefaulted = [...builders].filter(
    builder => !readFileSync(builder, 'utf8').includes('pgProjectDefaults()'),
  );
  expect(undefaulted).toEqual([]);
});

test('a pg project and a no-pg one never share a pool', () => {
  // The pairing vitest actually rejects, and the one the checks above cannot see:
  // they compare pg projects with each other, while the conflict is between a pg
  // project and its no-pg SIBLING in the same package. A bare `vitest run`
  // enumerates every project at once -- which is what the repo's own `test` script
  // does -- so this is reachable without setting TEST_PG_MODE at all, and both
  // TEST_PG_MODE runs hide it by filtering one side away.
  const pg = configForVersion(16, import.meta.url).test;
  const noPg = configForNoPg(import.meta.url).test;
  expect(pg.maxWorkers).not.toBe(noPg.maxWorkers);
  expect(pg.sequence?.groupOrder ?? 0).not.toBe(noPg.sequence?.groupOrder ?? 0);
});

test('the shared defaults carry what has to match', () => {
  // A tripwire on the source of truth: were `maxWorkers` dropped from it, every
  // config above would still spread it and the check would pass vacuously.
  const defaults = pgProjectDefaults();
  expect(defaults.maxWorkers).toBe(maxConcurrentPgFiles());
  expect(defaults.sequence.groupOrder).toBe(PG_PROJECT_GROUP_ORDER);
  expect(PG_PROJECT_GROUP_ORDER).not.toBe(0);
  expect(defaults.maxWorkers).toBeGreaterThan(0);
  expect(defaults.testTimeout).toBeGreaterThan(0);
  expect(defaults.hookTimeout).toBeGreaterThan(0);
});

test('the file bound stays under what one Postgres can serve', () => {
  // The number itself is a measurement, not a preference: unbounded spent 3084s of
  // test time to finish in 214s with a timeout failure, six workers spent 973s to
  // finish in 252s with none. A bound that drifts back up to the CPU count
  // reintroduces exactly that.
  expect(maxConcurrentPgFiles()).toBeLessThanOrEqual(6);
  expect(maxConcurrentPgFiles()).toBeGreaterThanOrEqual(1);
});
