import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {initialSync} from '../../../zero-cache/src/services/change-source/pg/initial-sync.ts';
import {getConnectionURI, testDBs} from '../../../zero-cache/src/test/db.ts';
import type {Row} from '../../../zero-protocol/src/data.ts';
import {clientToServer} from '../../../zero-schema/src/name-mapper.ts';
import type {Schema} from '../../../zero-types/src/schema.ts';
import {Database} from '../../../zqlite/src/db.ts';
import {appIdFor} from './app-id.ts';
import {releaseAll} from './teardown.ts';

export async function fillPgAndSync(
  schema: Schema,
  createTableSQL: string,
  testData: Record<string, Row[]>,
  dbName: string,
) {
  const lc = createSilentLogContext();
  const pg = await testDBs.create(dbName, {typeOpts: false});
  let sqlite: Database | undefined;

  // Everything past the create is cleaned up here rather than by the caller,
  // because a caller that never receives the handles cannot release them: a throw
  // from `createTableSQL` or from initial sync would otherwise leave the database
  // — and any replication slot sync had got as far as creating — for the rest of
  // the run, surfacing only as an "undropped databases" warning from a later file.
  try {
    await pg.unsafe(createTableSQL);
    sqlite = new Database(lc, ':memory:');

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
      // replication slot, so a constant here gives every caller the same slot in
      // the same Postgres instance, and whichever runs second fails setup with
      // `replication slot "…_0_a" already exists`.
      {appID: appIdFor(dbName), shardNum: 0, publications: []},
      sqlite,
      getConnectionURI(pg),
      {tableCopyWorkers: 1},
      {},
    );
  } catch (error) {
    // Through `releaseAll` so a failure closing the handle cannot skip the drop,
    // and so neither displaces the setup error being rethrown.
    await releaseAll([() => sqlite?.close(), () => testDBs.drop(pg)]).catch(
      cleanupError => {
        lc.warn?.('failed to clean up after setup error', cleanupError);
      },
    );
    throw error;
  }

  return {pg, sqlite};
}
