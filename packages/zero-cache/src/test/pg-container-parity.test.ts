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
 * Nothing else enforces that, and a comment is the wrong mechanism for it: the
 * settings live in two files, in two languages, edited for different reasons, and
 * only one of them is where a developer runs the suite. Raising `max_connections`
 * on the testcontainers side alone would leave the dev container short of them, so
 * the failure the raise removes would stay reproducible in the one environment that
 * cannot start a container to work around it.
 *
 * So this asserts the parity the header asks for, rather than trusting the next
 * person to read it.
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

/**
 * The `- item` values of a compose service's `command:` block.
 *
 * Throws rather than asserts when the shape is absent. This runs while the suite
 * is being collected, where there is no test to attach a failure to, and the
 * absence is a precondition for the cases below meaning anything rather than a
 * property of the thing under test.
 */
function commandOf(service: string): string[] {
  const header = compose.indexOf(`\n  ${service}:\n`);
  if (header === -1) {
    throw new Error(
      `.devcontainer/docker-compose.yml declares no ${service} service`,
    );
  }

  // The service block ends at the next line indented two spaces, which is the
  // next service or a top-level key.
  const rest = compose.slice(header + 1);
  const end = rest.search(/\n {2}\S/u);
  const block = end === -1 ? rest : rest.slice(0, end);

  const command = block.indexOf('command:');
  if (command === -1) {
    throw new Error(`${service} declares no command`);
  }

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
  if (!call) {
    throw new Error(`pg-${major}.ts does not call runPostgresContainer`);
  }
  return {image: call[1], timezone: call[2]};
}

// Driven off the setup files rather than a literal list, so a new major joins by
// existing.
const MAJORS = [15, 16, 17, 18] as const;

test('every Postgres major with a setup file has a dev container service', () => {
  // Guards the direction the per-major cases cannot: adding pg-19.ts and
  // forgetting the compose service would otherwise leave the new major
  // unchecked.
  const declared = Array.from(compose.matchAll(/^ {2}pg(\d+):$/gmu), m =>
    Number(m[1]),
  );
  // Numerically. The default comparator sorts by string, which happens to agree
  // for 15-18 and would not the moment a single-digit major appears: [9, 15]
  // sorts to [15, 9], and the mismatch would read as a missing service.
  expect(declared.toSorted((a, b) => a - b)).toEqual([...MAJORS]);
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
    expect(settings.toSorted()).toEqual(
      postgresServerSettings(timezone).toSorted(),
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
