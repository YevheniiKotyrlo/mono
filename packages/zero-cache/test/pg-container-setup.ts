import {PostgreSqlContainer} from '@testcontainers/postgresql';

const IMAGE_MAJOR_VERSION = /^postgres:(\d+)/;

/**
 * Server settings every Postgres the tests run against needs, whether started
 * here by testcontainers or supplied through `TEST_PG_<major>`.
 *
 * Exported so the dev container's compose file can be checked against it rather
 * than kept in step by hand; see
 * ../src/test/pg-container-parity.test.ts.
 */
export const SHARED_POSTGRES_SETTINGS = [
  'wal_level=logical',
  'max_replication_slots=100',
  'max_wal_senders=100',
  // Connection demand is set by how many test files run at once, not by how many
  // a project has: vitest isolates every file into its own fork and runs
  // `availableParallelism() - 1` of them concurrently, and each file holds on the
  // order of 20 connections (a postgres.js pool defaults to 10, and files that
  // sync hold a second pool). A 21-file project on a 32-core machine therefore
  // asks for ~400 at peak. Postgres defaults to 100, and past it suites fail in
  // setup with "sorry, too many clients already", which reads as a test failure
  // rather than a capacity limit. Allowing a connection costs ~50KB of shared
  // memory whether or not it is used, so this is cheap next to the alternative of
  // capping test concurrency.
  'max_connections=500',
] as const;

/** The full `-c` settings list for a Postgres started at a given timezone. */
export function postgresServerSettings(timezone: string): readonly string[] {
  return [...SHARED_POSTGRES_SETTINGS, `timezone=${timezone}`];
}

export function runPostgresContainer(image: string, timezone: string) {
  return async ({provide}) => {
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
