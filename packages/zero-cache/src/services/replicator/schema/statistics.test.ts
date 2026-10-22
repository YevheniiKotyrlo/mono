import {SilentLogger} from '@rocicorp/logger';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {createSilentLogContext} from '../../../../../shared/src/logging-test-utils.ts';
import {parseOptions} from '../../../../../shared/src/options.ts';
import {Database} from '../../../../../zqlite/src/db.ts';
import {
  DEFAULT_REPLICA_ANALYSIS_LIMIT,
  ZERO_ENV_VAR_PREFIX,
  zeroOptions,
} from '../../../config/zero-config.ts';
import {createLiteIndexStatement} from '../../../db/create.ts';
import {deleteLiteDB} from '../../../db/delete-lite-db.ts';
import {runSchemaMigrations} from '../../../db/migration-lite.ts';
import type {LiteIndexSpec} from '../../../db/specs.ts';
import {StatementRunner} from '../../../db/statements.ts';
import {DbFile, initDB} from '../../../test/lite.ts';
import {
  getPragmaConfig,
  replicaFileName,
  setupReplica,
  type ReplicaFileMode,
} from '../../../workers/replicator.ts';
import {
  initReplica,
  schemaVersionMigrationMap,
} from '../../change-source/common/replica-schema.ts';
import {ReplicaPoller} from '../../change-streamer/replica-poller.ts';
import {ChangeProcessor} from '../change-processor.ts';
import {fakeReplicator, ReplicationMessages} from '../test-utils.ts';
import {applyPragmas, ThreadWriteWorkerClient} from '../write-worker-client.ts';
import {initReplicationState} from './replication-state.ts';

const lc = createSilentLogContext();

const ROWS = 10_000;

// The replica schema version before the one that adds `_zero.statistics`.
const VERSION_BEFORE_STATISTICS = 18;

// Every row has the same `deleted`, so statistics read from every row give an
// index led by it ROWS rows per value, and a sample about as many as it read.
const ROWS_OF_ONE_VALUE = Array.from({length: ROWS}, (_, index) => ({
  id: index + 1,
  deleted: 0,
  created_at: index + 1,
}));

function deletedCreatedIndex(table: string): LiteIndexSpec {
  return {
    name: `${table}_deleted_created`,
    tableName: table,
    unique: false,
    columns: {deleted: 'ASC', created_at: 'ASC', id: 'ASC'},
  };
}

const ITEM_INDEX = {schema: 'public', ...deletedCreatedIndex('item')};

function createTable(db: Database, table: string) {
  initDB(
    db,
    /*sql*/ `
      CREATE TABLE "${table}" (
        id INTEGER PRIMARY KEY,
        deleted INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    {[table]: ROWS_OF_ONE_VALUE},
  );
}

function createIndex(db: Database, table: string) {
  db.exec(createLiteIndexStatement(deletedCreatedIndex(table)));
}

function hasStatistics(db: Database): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE name = 'sqlite_stat1'`)
      .get() !== undefined
  );
}

function readRowsPerLeadingValue(
  db: Database,
  index: string,
): number | undefined {
  if (!hasStatistics(db)) {
    return undefined;
  }
  const row = db
    .prepare('SELECT stat FROM sqlite_stat1 WHERE idx = ?')
    .get<{stat: string} | undefined>(index);
  return row === undefined ? undefined : Number(row.stat.split(' ')[1]);
}

function rowsPerLeadingValue(path: string, index: string): number | undefined {
  const db = new Database(lc, path, {readonly: true});
  try {
    return readRowsPerLeadingValue(db, index);
  } finally {
    db.close();
  }
}

function recordedAnalysisLimit(path: string): number | undefined {
  const db = new Database(lc, path, {readonly: true});
  try {
    return db
      .prepare(`SELECT analysisLimit FROM "_zero.statistics"`)
      .get<{analysisLimit: number} | undefined>()?.analysisLimit;
  } finally {
    db.close();
  }
}

// A sample reads as many rows as the limit, or one more.
function sampleSizes(analysisLimit: number): readonly number[] {
  return [analysisLimit, analysisLimit + 1];
}

describe('replica.analysisLimit', () => {
  function parseReplicaOptions(
    env: Readonly<Record<string, string>>,
    argv: string[] = [],
  ) {
    return parseOptions(
      {replica: zeroOptions.replica},
      {
        argv,
        env,
        envNamePrefix: ZERO_ENV_VAR_PREFIX,
        logger: new SilentLogger(),
      },
    ).replica;
  }

  test('samples 1000 rows by default', () => {
    expect(parseReplicaOptions({}).analysisLimit).toBe(1000);
  });

  test('is read from the environment and the command line', () => {
    expect(
      parseReplicaOptions({ZERO_REPLICA_ANALYSIS_LIMIT: '0'}).analysisLimit,
    ).toBe(0);
    expect(
      parseReplicaOptions({}, ['--replica-analysis-limit', '5000'])
        .analysisLimit,
    ).toBe(5000);
  });

  test('takes the largest limit SQLite stores', () => {
    expect(
      parseReplicaOptions({ZERO_REPLICA_ANALYSIS_LIMIT: '2147483647'})
        .analysisLimit,
    ).toBe(2147483647);
  });

  // SQLite ignores a negative limit and one it does not parse as an integer,
  // which leaves the connection at its previous limit, and keeps only the low
  // 31 bits of a larger one.
  test.each([
    ['-1', '-1'],
    ['1.5', '1.5'],
    ['2147483648', '2147483648'],
    ['1e21', '1e+21'],
  ])('refuses %s', (limit, shown) => {
    expect(() =>
      parseReplicaOptions({ZERO_REPLICA_ANALYSIS_LIMIT: limit}),
    ).toThrow(
      new TypeError(
        `must be an integer between 0 and 2147483647 at replica.analysisLimit. Got ${shown}`,
      ),
    );
  });
});

describe('replica statistics', () => {
  let file: DbFile;

  beforeEach(() => {
    file = new DbFile('replica-statistics');
  });

  afterEach(() => {
    file.delete();
    deleteLiteDB(replicaFileName(file.path, 'serving-copy'));
  });

  function syncReplica(): Promise<void> {
    return initReplica(lc, 'replica', file.path, (_, tx) => {
      initReplicationState(tx, ['zero_data'], '01');
      createTable(tx, 'item');
      createIndex(tx, 'item');
      return Promise.resolve();
    });
  }

  function prepare(analysisLimit: number, mode: ReplicaFileMode = 'serving') {
    return setupReplica(lc, mode, {file: file.path, analysisLimit});
  }

  // A table replicated while empty, which its schema change leaves without
  // statistics, and filled since.
  function addUnanalyzedTable() {
    const db = new Database(lc, file.path);
    try {
      createTable(db, 'other');
      createIndex(db, 'other');
    } finally {
      db.close({optimize: false});
    }
  }

  test('a synced replica is analyzed from every row under a limit of 0', async () => {
    await syncReplica();
    await prepare(0);

    expect(rowsPerLeadingValue(file.path, 'item_deleted_created')).toBe(ROWS);
    expect(recordedAnalysisLimit(file.path)).toBe(0);
  });

  test.each([1000, 5000])(
    'a synced replica is sampled under a limit of %d',
    async analysisLimit => {
      await syncReplica();
      await prepare(analysisLimit);

      expect(rowsPerLeadingValue(file.path, 'item_deleted_created')).toBeOneOf(
        sampleSizes(analysisLimit),
      );
      expect(recordedAnalysisLimit(file.path)).toBe(analysisLimit);
    },
  );

  test("a synced replica the change-streamer polls first is analyzed under the replicator's limit", async () => {
    await syncReplica();
    new ReplicaPoller(lc, file.path).start().cancel();
    await prepare(0);

    expect(rowsPerLeadingValue(file.path, 'item_deleted_created')).toBe(ROWS);
  });

  test('a changed limit gathers every table again', async () => {
    await syncReplica();
    await prepare(1000);
    await prepare(0);

    expect(rowsPerLeadingValue(file.path, 'item_deleted_created')).toBe(ROWS);
    expect(recordedAnalysisLimit(file.path)).toBe(0);
  });

  test("an unanalyzed table the change-streamer polls past is analyzed at the replicator's next preparation", async () => {
    await syncReplica();
    await prepare(0);
    addUnanalyzedTable();
    new ReplicaPoller(lc, file.path).start().cancel();
    await prepare(0);

    expect(rowsPerLeadingValue(file.path, 'other_deleted_created')).toBe(ROWS);
  });

  test('copying the replica to serve gathers no statistics on the original', async () => {
    await syncReplica();
    await prepare(0, 'backup');
    addUnanalyzedTable();
    await prepare(0, 'serving-copy');

    expect(
      rowsPerLeadingValue(file.path, 'other_deleted_created'),
    ).toBeUndefined();
    expect(
      rowsPerLeadingValue(
        replicaFileName(file.path, 'serving-copy'),
        'other_deleted_created',
      ),
    ).toBe(ROWS);
  });

  test('stopping the write worker gathers no statistics', async () => {
    await syncReplica();
    await prepare(0);
    addUnanalyzedTable();

    const worker = new ThreadWriteWorkerClient();
    await worker.init(file.path, 'serving', getPragmaConfig('serving', 0), {
      level: 'error',
      format: 'text',
    });
    await worker.stop();

    expect(
      rowsPerLeadingValue(file.path, 'other_deleted_created'),
    ).toBeUndefined();
  });

  test('a preparation that fails before gathering statistics gathers none', async () => {
    await syncReplica();
    await prepare(0, 'backup');
    addUnanalyzedTable();

    // An open read transaction keeps the replicator from moving the replica
    // out of 'wal' mode, as a serving replica must.
    const reader = new Database(lc, file.path, {readonly: true});
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM item').get();
      await expect(prepare(0)).rejects.toThrow('database is locked');
    } finally {
      reader.close();
    }

    expect(
      rowsPerLeadingValue(file.path, 'other_deleted_created'),
    ).toBeUndefined();
  });

  test('a rollback past the record, and forward again, gathers every table again', async () => {
    await syncReplica();
    await prepare(0);

    // An earlier zero-cache resets the replica's data version to its own, and
    // gathers statistics of its own.
    const earlierVersions = Object.fromEntries(
      Object.entries(schemaVersionMigrationMap).filter(
        ([version]) => Number(version) <= VERSION_BEFORE_STATISTICS,
      ),
    );
    await runSchemaMigrations(lc, 'replica', file.path, {}, earlierVersions);
    const earlier = new Database(lc, file.path);
    try {
      earlier.pragma('analysis_limit = 1000');
      earlier.exec('ANALYZE item');
    } finally {
      earlier.close({optimize: false});
    }

    await prepare(0);

    expect(rowsPerLeadingValue(file.path, 'item_deleted_created')).toBe(ROWS);
    expect(recordedAnalysisLimit(file.path)).toBe(0);
  });

  test('a replica analyzed before the record keeps its statistics under the default limit', async () => {
    await syncReplica();
    await prepare(5000);

    const earlier = new Database(lc, file.path);
    try {
      earlier.exec(/*sql*/ `
        DROP TABLE "_zero.statistics";
        UPDATE "_zero.versionHistory"
          SET dataVersion = ${VERSION_BEFORE_STATISTICS},
              schemaVersion = ${VERSION_BEFORE_STATISTICS}`);
    } finally {
      earlier.close({optimize: false});
    }
    await prepare(DEFAULT_REPLICA_ANALYSIS_LIMIT);

    expect(rowsPerLeadingValue(file.path, 'item_deleted_created')).toBeOneOf(
      sampleSizes(5000),
    );
    expect(recordedAnalysisLimit(file.path)).toBe(
      DEFAULT_REPLICA_ANALYSIS_LIMIT,
    );
  });
});

describe('replica statistics after a replicated schema change', () => {
  function replicateIndexCreation(analysisLimit: number): number | undefined {
    const replica = new Database(lc, ':memory:');
    try {
      initReplicationState(replica, ['zero_data'], '01');
      applyPragmas(replica, getPragmaConfig('serving', analysisLimit));
      createTable(replica, 'item');

      fakeReplicator(lc, replica).processTransaction(
        '02',
        new ReplicationMessages({item: 'id'}).createIndex(ITEM_INDEX),
      );
      return readRowsPerLeadingValue(replica, 'item_deleted_created');
    } finally {
      replica.close({optimize: false});
    }
  }

  test('a replicated index is analyzed from every row under a limit of 0', () => {
    expect(replicateIndexCreation(0)).toBe(ROWS);
  });

  // Above the 2000 rows SQLite's default mask puts in place of a larger limit.
  test('a replicated index is sampled under a limit of 5000', () => {
    expect(replicateIndexCreation(5000)).toBeOneOf(sampleSizes(5000));
  });

  test('an initial sync leaves statistics to the replicator', () => {
    const replica = new Database(lc, ':memory:');
    try {
      initReplicationState(replica, ['zero_data'], '01');
      createTable(replica, 'item');

      const processor = new ChangeProcessor(
        new StatementRunner(replica),
        'initial-sync',
        (_, err) => {
          throw err;
        },
      );
      const messages = new ReplicationMessages({item: 'id'});
      processor.processMessage(lc, [
        'begin',
        messages.begin(),
        {commitWatermark: '02'},
      ]);
      processor.processMessage(lc, ['data', messages.createIndex(ITEM_INDEX)]);
      processor.processMessage(lc, [
        'commit',
        messages.commit(),
        {watermark: '02'},
      ]);

      expect(hasStatistics(replica)).toBe(false);
    } finally {
      replica.close({optimize: false});
    }
  });
});
