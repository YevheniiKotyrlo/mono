import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {describe, expect, test} from 'vitest';
import {
  SHARED_POSTGRES_SETTINGS,
  postgresServerSettings,
} from '../../test/pg-container-setup.ts';

/**
 * The pg tests reach Postgres two ways: testcontainers starts one, or
 * `TEST_PG_<major>` points at a running instance. The dev container uses the
 * second, with the instances declared in .devcontainer/docker-compose.yml — whose
 * own header says its server settings "must match the testcontainers setup".
 *
 * Nothing enforced that, and the two did drift: raising `max_connections` on the
 * container left the dev container at the default, so the failure the raise fixes
 * stayed reproducible in the one environment that cannot start a container to work
 * around it. A comment cannot hold two files in step, so this does.
 */

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);
const COMPOSE_FILE = join(REPO_ROOT, '.devcontainer', 'docker-compose.yml');
const SETUP_DIR = join(REPO_ROOT, 'packages', 'zero-cache', 'test');

const compose = readFileSync(COMPOSE_FILE, 'utf8');

/** The `- item` values of a compose service's `command:` block. */
function commandOf(service: string): string[] {
  const header = compose.indexOf(`\n  ${service}:\n`);
  expect(
    header,
    `.devcontainer/docker-compose.yml declares no ${service} service`,
  ).toBeGreaterThan(-1);

  // The service block ends at the next line indented two spaces, which is the
  // next service or a top-level key.
  const rest = compose.slice(header + 1);
  const end = rest.search(/\n {2}\S/u);
  const block = end === -1 ? rest : rest.slice(0, end);

  const command = block.indexOf('command:');
  expect(command, `${service} declares no command`).toBeGreaterThan(-1);

  const items: string[] = [];
  for (const line of block.slice(command).split('\n').slice(1)) {
    const item = /^ {6}- (.+)$/u.exec(line);
    if (!item) {
      // A comment or blank line inside the list is fine; anything else ends it.
      if (/^\s*(#|$)/u.test(line)) {
        continue;
      }
      break;
    }
    items.push(item[1].trim());
  }
  return items;
}

/** The image and timezone `test/pg-<major>.ts` starts its container with. */
function setupArgumentsFor(major: number): {image: string; timezone: string} {
  const source = readFileSync(join(SETUP_DIR, `pg-${major}.ts`), 'utf8');
  const call = /runPostgresContainer\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/u.exec(
    source,
  );
  expect(
    call,
    `pg-${major}.ts does not call runPostgresContainer`,
  ).not.toBeNull();
  return {image: call![1], timezone: call![2]};
}

// Driven off the setup files rather than a literal list, so a new major joins by
// existing.
const MAJORS = [15, 16, 17, 18] as const;

test('every Postgres major with a setup file has a dev container service', () => {
  // Guards the direction the per-major cases cannot: adding pg-19.ts and
  // forgetting the compose service would otherwise leave the new major
  // unchecked.
  const declared = [...compose.matchAll(/^ {2}pg(\d+):$/gmu)].map(m =>
    Number(m[1]),
  );
  expect(declared.sort()).toEqual([...MAJORS]);
});

describe.each(MAJORS)('pg%d', major => {
  const {image, timezone} = setupArgumentsFor(major);
  const command = commandOf(`pg${major}`);

  test('passes the same server settings as the container', () => {
    // Not a subset check on the whole list: each setting is asserted so the
    // failure names the one that drifted.
    for (const setting of postgresServerSettings(timezone)) {
      expect(command).toContain(setting);
    }
  });

  test('runs the same image', () => {
    expect(compose).toContain(`image: ${image}`);
  });

  test('sets no server setting the container does not', () => {
    // The reverse drift: a setting added only to the dev container makes the two
    // environments differ, and the tests would pass in one and fail in the other.
    const settings = command.filter(
      item => item !== 'postgres' && item !== '-c',
    );
    expect(settings.sort()).toEqual(
      [...postgresServerSettings(timezone)].sort(),
    );
  });
});

test('the shared settings are the ones both environments need', () => {
  // A tripwire on the source of truth itself: were the list emptied, every case
  // above would pass vacuously.
  expect(SHARED_POSTGRES_SETTINGS).toContain('wal_level=logical');
  expect(SHARED_POSTGRES_SETTINGS.length).toBeGreaterThanOrEqual(4);
  expect(postgresServerSettings('UTC')).toContain('timezone=UTC');
});
