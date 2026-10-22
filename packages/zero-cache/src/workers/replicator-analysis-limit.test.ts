import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {parseOptions} from '../../../shared/src/options.ts';
import {Database} from '../../../zqlite/src/db.ts';
import {ZERO_ENV_VAR_PREFIX, zeroOptions} from '../config/zero-config.ts';
import {StatementRunner} from '../db/statements.ts';
import {initReplica} from '../services/change-source/common/replica-schema.ts';
import {
  ChangeProcessor,
  REPLICA_OPTIMIZE_MASK,
} from '../services/replicator/change-processor.ts';
import {initReplicationState} from '../services/replicator/schema/replication-state.ts';
import {
  fakeReplicator,
  ReplicationMessages,
} from '../services/replicator/test-utils.ts';
import {applyPragmas} from '../services/replicator/write-worker-client.ts';
import {DbFile} from '../test/lite.ts';
import {getPragmaConfig, setupReplica} from './replicator.ts';

const ROWS = 10_000;

const ITEM_INDEX = {
  schema: 'public',
  tableName: 'item',
  name: 'item_deleted_created',
  unique: false,
  columns: {deleted: 'ASC', created_at: 'ASC', id: 'ASC'},
} as const;

// Every row has the same `deleted`, so statistics read from every row give the
// index's leading column ROWS rows per value, and a sample about as many rows
// as it read.
function createItems(db: Database) {
  db.exec(/*sql*/ `
    CREATE TABLE item (
      id INTEGER PRIMARY KEY,
      deleted INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
  const insert = db.prepare(
    'INSERT INTO item (id, deleted, created_at) VALUES (?, 0, ?)',
  );
  db.transaction(() => {
    for (let id = 1; id <= ROWS; id++) {
      insert.run(id, id);
    }
  });
}

function rowsPerLeadingValue(db: Database, index: string): number {
  const {stat} = db
    .prepare('SELECT stat FROM sqlite_stat1 WHERE idx = ?')
    .get<{stat: string}>(index);
  return Number(stat.split(' ')[1]);
}

describe('replica.analysisLimit', () => {
  const parseReplicaOptions = (
    env: Record<string, string>,
    argv: string[] = [],
  ) =>
    parseOptions(
      {replica: zeroOptions.replica},
      {argv, env, envNamePrefix: ZERO_ENV_VAR_PREFIX},
    ).replica;

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

  // SQLite ignores a negative analysis_limit, which would leave the replica's
  // connection at whatever limit it last held.
  test.each(['-1', '1.5'])('refuses %s', limit => {
    expect(() =>
      parseReplicaOptions({ZERO_REPLICA_ANALYSIS_LIMIT: limit}),
    ).toThrow('replica.analysisLimit must be an integer >= 0');
  });
});

describe('replica analysis limit', () => {
  const lc = createSilentLogContext();
  let file: DbFile;

  beforeEach(() => {
    file = new DbFile('replica-analysis-limit');
  });

  afterEach(() => {
    file.delete();
  });

  async function syncAndPrepare(analysisLimit: number): Promise<number> {
    await initReplica(lc, 'replica', file.path, (_, tx) => {
      initReplicationState(tx, ['zero_data'], '01');
      createItems(tx);
      tx.exec(/*sql*/ `
        CREATE INDEX item_deleted_created ON item (deleted, created_at, id)`);
      return Promise.resolve();
    });
    await setupReplica(lc, 'serving', {file: file.path, analysisLimit});
    const replica = file.connect(lc);
    try {
      return rowsPerLeadingValue(replica, 'item_deleted_created');
    } finally {
      replica.close();
    }
  }

  test('a synced replica is analyzed from every row under a limit of 0', async () => {
    expect(await syncAndPrepare(0)).toBe(ROWS);
  });

  test.each([1000, 5000])(
    'a synced replica is sampled under a limit of %d',
    async analysisLimit => {
      const rows = await syncAndPrepare(analysisLimit);
      expect(rows).toBeGreaterThanOrEqual(analysisLimit);
      expect(rows).toBeLessThanOrEqual(analysisLimit + 1);
    },
  );

  function replicateIndexCreation(analysisLimit: number): number {
    const replica = new Database(lc, ':memory:');
    initReplicationState(replica, ['zero_data'], '01');
    applyPragmas(replica, getPragmaConfig('serving', analysisLimit));
    createItems(replica);

    const messages = new ReplicationMessages({item: 'id'});
    fakeReplicator(lc, replica).processTransaction(
      '02',
      messages.createIndex(ITEM_INDEX),
    );
    return rowsPerLeadingValue(replica, 'item_deleted_created');
  }

  test('a replicated index is analyzed from every row under a limit of 0', () => {
    expect(replicateIndexCreation(0)).toBe(ROWS);
  });

  test.each([1000, 5000])(
    'a replicated index is sampled under a limit of %d',
    analysisLimit => {
      const rows = replicateIndexCreation(analysisLimit);
      expect(rows).toBeGreaterThanOrEqual(analysisLimit);
      expect(rows).toBeLessThanOrEqual(analysisLimit + 1);
    },
  );

  test("the replicator's connection closes under a limit of 0, reading every row", () => {
    const replica = file.connect(lc);
    applyPragmas(replica, getPragmaConfig('serving', 0));
    createItems(replica);
    replica.exec(/*sql*/ `
      CREATE INDEX item_deleted_created ON item (deleted, created_at, id)`);
    replica.close({optimize: REPLICA_OPTIMIZE_MASK});

    const reopened = file.connect(lc);
    try {
      expect(rowsPerLeadingValue(reopened, 'item_deleted_created')).toBe(ROWS);
    } finally {
      reopened.close({optimize: false});
    }
  });

  test('an initial sync leaves statistics to the replicator', () => {
    const replica = new Database(lc, ':memory:');
    initReplicationState(replica, ['zero_data'], '01');
    createItems(replica);

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

    expect(
      replica
        .prepare(
          `SELECT count(*) AS count FROM sqlite_master WHERE name = 'sqlite_stat1'`,
        )
        .get<{count: number}>().count,
    ).toBe(0);
  });
});
