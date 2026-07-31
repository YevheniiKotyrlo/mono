import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {initialSync} from '../../../zero-cache/src/services/change-source/pg/initial-sync.ts';
import {getConnectionURI, testDBs} from '../../../zero-cache/src/test/db.ts';
import type {Row} from '../../../zero-protocol/src/data.ts';
import {clientToServer} from '../../../zero-schema/src/name-mapper.ts';
import type {Schema} from '../../../zero-types/src/schema.ts';
import {Database} from '../../../zqlite/src/db.ts';

export async function fillPgAndSync(
  schema: Schema,
  createTableSQL: string,
  testData: Record<string, Row[]>,
  dbName: string,
) {
  const lc = createSilentLogContext();
  const pg = await testDBs.create(dbName, {typeOpts: false});

  await pg.unsafe(createTableSQL);
  const sqlite = new Database(lc, ':memory:');

  const mapper = clientToServer(schema.tables);
  for (const [table, rows] of Object.entries(testData)) {
    const columns = Object.keys(rows[0]);
    const forPg = rows.map(row =>
      columns.reduce(
        (acc, c) => ({
          ...acc,
          [mapper.columnName(table, c)]: row[c],
        }),
        {} as Record<string, unknown>,
      ),
    );
    await pg`INSERT INTO ${pg(mapper.tableName(table))} ${pg(forPg)}`;
  }

  await initialSync(
    lc,
    // Derived from the database rather than fixed: the app id names the
    // replication slot, so a constant here gives every caller the same slot in the
    // same Postgres instance. The second one to run then fails setup with
    // `replication slot "…_0_a" already exists`.
    {appID: appIdFor(dbName), shardNum: 0, publications: []},
    sqlite,
    getConnectionURI(pg),
    {tableCopyWorkers: 1},
    {},
  );

  return {pg, sqlite};
}

/** A slot-safe app id: replication slot names allow only [a-z0-9_]. */
function appIdFor(dbName: string): string {
  return dbName.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '_');
}
