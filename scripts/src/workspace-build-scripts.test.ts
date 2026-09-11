import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect, test} from 'vitest';

/**
 * No workspace builds another workspace from its own script.
 *
 * turbo already knows the build order: `build` declares `dependsOn: ["^build"]`,
 * so a package that depends on another has it built first. A script that shells
 * into a sibling's build instead runs OUTSIDE that graph, and turbo schedules it
 * concurrently with the other consumers of the same output — one task rewriting
 * `packages/zero/out` while another reads it.
 *
 * That failure does not look like a race. It surfaces as whichever module was
 * mid-write: three consecutive runs reported `Cannot find module out/shared/src/
 * asserts.js` twice and `out/z2s/src/sql.js` once, which reads as a broken package
 * rather than as two tasks sharing a directory.
 *
 * Removing the one instance fixes it today; this is what stops the next one, since
 * the shape is an easy thing to reach for and the damage is invisible at the call
 * site.
 */

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PACKAGE_ROOTS = ['packages', 'apps', 'tools'] as const;

/** `pnpm --filter <other> run build`, and the `-F` shorthand. */
const CROSS_PACKAGE_BUILD =
  /\bpnpm\s+(?:--filter|-F)[= ]\s*\S+\s+(?:run\s+)?build\b/u;

function workspaceManifests(): {
  path: string;
  scripts: Record<string, string>;
}[] {
  const found: {path: string; scripts: Record<string, string>}[] = [];
  for (const root of PACKAGE_ROOTS) {
    let entries: string[];
    try {
      entries = readdirSync(join(WORKSPACE_ROOT, root));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const manifest = join(WORKSPACE_ROOT, root, entry, 'package.json');
      let raw: string;
      try {
        raw = readFileSync(manifest, 'utf-8');
      } catch {
        continue;
      }
      const parsed = JSON.parse(raw) as {scripts?: Record<string, string>};
      found.push({
        path: relative(WORKSPACE_ROOT, manifest).replaceAll('\\', '/'),
        scripts: parsed.scripts ?? {},
      });
    }
  }
  return found;
}

test('no workspace script builds another workspace', () => {
  const offenders = workspaceManifests().flatMap(({path, scripts}) =>
    Object.entries(scripts)
      .filter(([, command]) => CROSS_PACKAGE_BUILD.test(command))
      .map(([name, command]) => `${path} :: "${name}": "${command}"`),
  );
  expect(offenders).toEqual([]);
});

test('the scan reaches the workspaces, so an empty result means something', () => {
  // Without this, a rename of a package root would empty the input and the
  // assertion above would pass by checking nothing — the failure mode the gate
  // it guards was itself an example of.
  const manifests = workspaceManifests();
  expect(manifests.length).toBeGreaterThan(20);
  expect(
    manifests.some(m => m.path === 'apps/zero-throughput/package.json'),
  ).toBe(true);
});

test('the pattern matches the shape it exists for, and not ordinary builds', () => {
  expect(
    CROSS_PACKAGE_BUILD.test('pnpm --filter @rocicorp/zero run build'),
  ).toBe(true);
  expect(CROSS_PACKAGE_BUILD.test('pnpm -F @rocicorp/zero build')).toBe(true);
  // A package building itself, and turbo driving the graph, are both fine.
  expect(CROSS_PACKAGE_BUILD.test('tsc && vite build')).toBe(false);
  expect(CROSS_PACKAGE_BUILD.test('turbo run build')).toBe(false);
  expect(CROSS_PACKAGE_BUILD.test('pnpm run build')).toBe(false);
});
