import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';
import {appIdFor} from './app-id.ts';

/**
 * A suite's name becomes a Postgres database, a replication slot, and a SQLite file,
 * so two suites sharing one is a collision on all three.
 *
 * Testcontainers hides this: each package's project starts its own container, so a
 * duplicate across packages never meets itself. The dev container does not — its
 * `TEST_PG_<major>` variables are set on the workspace, so every package's pg tests
 * point at the same four servers, and there a duplicate fails setup with `replication
 * slot "..._0_a" already exists` or silently shares a database. `frontend_analysis`
 * was used by a suite in each package, which is what this was written for.
 *
 * Cross-package on purpose: the collision only exists between packages, so a check
 * scoped to one could never see it.
 */

const PACKAGES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

// Every package whose pg tests reach a Postgres through the shared harness. A new
// one joins by being listed; the count assertion below keeps that honest.
const PACKAGES = ['zql-integration-tests', 'zql-benchmarks'] as const;

/** Every `.ts` under a directory. Node's own walk: these tests run under vitest. */
function typescriptFilesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...typescriptFilesUnder(path));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(path);
    }
  }
  return files;
}

/** `suiteName: '...'` and `testDBs.create('...')` across a package's sources. */
function collectSuiteNames(packageName: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const root = join(PACKAGES_DIR, packageName);

  for (const file of typescriptFilesUnder(join(root, 'src'))) {
    // This file documents both patterns it searches for, so scanning itself finds
    // its own prose.
    if (file === fileURLToPath(import.meta.url)) {
      continue;
    }
    // Comments are not stripped: a commented-out suite name creates no database, but
    // it is also not worth a parser here, and a false positive is a rename away.
    const source = readFileSync(file, 'utf8');
    const names = [
      ...source.matchAll(/suiteName:\s*'([^']+)'/gu),
      ...source.matchAll(/testDBs\.create\(\s*'([^']+)'/gu),
      // A name bound to a const and passed through, which is how the two suites
      // that collided were written — neither reaches `testDBs.create` as a
      // literal, so a scan of the call sites alone could not see them.
      ...source.matchAll(/\bconst \w*DB_NAME\w* = '([^']+)'/gu),
      // And an app id written out rather than derived: it lands on a slot the
      // same way a name does, so two suites sharing one collide identically.
      ...source.matchAll(/\bappID:\s*'([^']+)'/gu),
    ].map(match => match[1]);

    for (const name of names) {
      const where = `${packageName}/${relative(root, file).replaceAll('\\', '/')}`;
      found.set(name, [...(found.get(name) ?? []), where]);
    }
  }
  return found;
}

const byName = new Map<string, string[]>();
for (const packageName of PACKAGES) {
  for (const [name, places] of collectSuiteNames(packageName)) {
    byName.set(name, [...(byName.get(name) ?? []), ...places]);
  }
}

test('no two suites share a name', () => {
  const duplicates = [...byName]
    .filter(([, places]) => places.length > 1)
    .map(([name, places]) => `${name}: ${places.join(', ')}`);

  expect(duplicates).toEqual([]);
});

test('no two suites share a replication slot', () => {
  // Distinct names are not enough on their own: the slot comes from the app id, and
  // ids are what Postgres actually collides on. `appIdFor` is injective, so this
  // holds as long as the names are distinct — which is the property worth pinning,
  // since a future id scheme that sanitises without disambiguating would break it
  // while every name stayed unique.
  const ids = Array.from(byName.keys(), appIdFor);
  expect(new Set(ids).size).toBe(byName.size);
});

test('the scan found the suites it is meant to cover', () => {
  // Without this, a broken glob or a moved directory turns both assertions above
  // into vacuous passes over an empty map.
  expect(byName.size).toBeGreaterThan(20);
  expect([...byName.keys()]).toContain('check_zql_string');
  expect([...byName.keys()]).toContain('frontend_analysis');
  // The two shapes a call-site scan cannot see. Named individually because each
  // needs its own pattern, so losing one leaves the other reading clean.
  expect([...byName.keys()]).toContain('collate-test');
  expect([...byName.keys()]).toContain('text-semantics-test');
});
