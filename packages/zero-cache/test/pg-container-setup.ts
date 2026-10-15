import {PostgreSqlContainer} from '@testcontainers/postgresql';
import type {TestProject} from 'vitest/node';

const IMAGE_MAJOR_VERSION = /^postgres:(\d+)/;

/**
 * Server settings every Postgres the tests run against needs, whether started
 * here by testcontainers or supplied through `TEST_PG_<major>`.
 */
export const SHARED_POSTGRES_SETTINGS = [
  'wal_level=logical',
  'max_replication_slots=100',
  'max_wal_senders=100',
  // vitest runs `availableParallelism() - 1` test files at once, each holding a
  // postgres.js pool or two, so connection demand follows the machine's cores.
  // Past Postgres's default of 100, setup fails with "sorry, too many clients
  // already", which reads as a test failure rather than a capacity limit.
  'max_connections=500',
] as const;

/** The full `-c` settings list for a Postgres started at a given timezone. */
export function postgresServerSettings(timezone: string): readonly string[] {
  return [...SHARED_POSTGRES_SETTINGS, `timezone=${timezone}`];
}

export function runPostgresContainer(image: string, timezone: string) {
  return async ({provide}: Pick<TestProject, 'provide'>) => {
    // TEST_PG_<major> (e.g. TEST_PG_16=postgres://user:password@pg16:5432/postgres)
    // points the tests at an already-running Postgres instead of starting one
    // with testcontainers. The instance must be configured with the same
    // server settings as the container started below. This is how the dev
    // container runs the pg tests without a Docker daemon; see
    // .devcontainer/docker-compose.yml.
    const major = image.match(IMAGE_MAJOR_VERSION)?.[1];
    const externalUri = major && process.env[`TEST_PG_${major}`];
    if (externalUri) {
      provide('pgConnectionString', externalUri);
      provide('pgImage', image);
      provide('pgTimezone', timezone);
      return;
    }

    const container = await new PostgreSqlContainer(image)
      .withCommand([
        'postgres',
        ...postgresServerSettings(timezone).flatMap(setting => ['-c', setting]),
      ])
      .start();

    // Referenced by ./src/test/db.ts
    provide('pgConnectionString', container.getConnectionUri());
    provide('pgImage', image);
    provide('pgTimezone', timezone);

    return async () => {
      await container.stop();
    };
  };
}
