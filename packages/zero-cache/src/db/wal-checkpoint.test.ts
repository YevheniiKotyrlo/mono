import {Worker} from 'worker_threads';
import {resolver} from '@rocicorp/resolver';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {createSilentLogContext} from '../../../shared/src/logging-test-utils.ts';
import {DbFile} from '../test/lite.ts';

describe('db/wal-checkpoint', () => {
  let dbFile: DbFile;

  const lc = createSilentLogContext();

  beforeEach(() => {
    dbFile = new DbFile('wal-checkpoint');
    const conn = dbFile.connect(lc);
    conn.pragma('journal_mode = WAL');
    conn.pragma('synchronous = NORMAL');
    conn.exec(`
      CREATE TABLE foo(id INTEGER PRIMARY KEY);
      INSERT INTO foo(id) VALUES(1);
      INSERT INTO foo(id) VALUES(2);
      INSERT INTO foo(id) VALUES(3);
    `);
    conn.close();
  });

  let worker: Worker | undefined;

  afterEach(async () => {
    // The worker holds its own connection to the replica, which DbFile cannot
    // see, and Windows refuses to unlink a file with an open handle. The test
    // starts the worker, so the test shuts it down — here rather than in each
    // branch, so neither can forget.
    const running = worker;
    worker = undefined;
    try {
      await running?.terminate();
    } finally {
      // In a `finally` so a failing terminate still removes the replica, and the
      // handle is cleared first so the next test cannot inherit a stale one.
      dbFile.delete();
    }
  });

  type Checkpoint = {
    busy: number;
    log: number;
    checkpointed: number;
  }[];

  type TransactionMode = 'IMMEDIATE' | 'CONCURRENT';

  test.each([['IMMEDIATE'], ['CONCURRENT']] satisfies [TransactionMode][])(
    'wal_checkpoint with BEGIN %s',
    async transaction => {
      const writer = dbFile.connect(lc);
      writer.pragma('wal_autocheckpoint = 0');
      writer.pragma('busy_timeout = 100');

      const insert = writer.prepare('INSERT INTO foo(id) VALUES(?)');
      for (let i = 10; i < 20; i++) {
        insert.run(i);
      }

      // Simulate a concurrent transaction (e.g. replicator) in a different thread.
      worker = new Worker(
        `
      const {parentPort} = require('worker_threads');
      const Database = require('@rocicorp/zero-sqlite3');

      // Acquire a read lock.
      const {workerData} = require('worker_threads');
      // The path arrives as workerData, not interpolated into this source: a
      // Windows path is full of backslashes, which a source-level template
      // turns into escape sequences and mangles.
      const reader = new Database(workerData.dbPath);
      reader.pragma('busy_timeout = 5000');
      const count = reader.prepare('select count(*) as count from foo');

      reader.prepare('begin ${transaction}').run();
      const before = count.get();
      reader.prepare('insert into foo(id) VALUES(30)').run();

      parentPort.postMessage('inTransaction');

      // Commit the transaction when a message is posted to this worker.
      parentPort.once('message', () => {
        reader.prepare('commit').run();
        const after = count.get();

        // Respond with the before and after counts.
        parentPort.postMessage({before, after});
      });
    `,
        {eval: true, workerData: {dbPath: dbFile.path}},
      );

      const {promise: inTransaction, resolve: setRunning} = resolver();
      worker.once('message', setRunning);
      await inTransaction;

      if (transaction === 'CONCURRENT') {
        // With a BEGIN CONCURRENT, the checkpoint fails without waiting. Note
        // that if this were litestream, this would result in a deadlock as
        // litestream does not set a busy_timeout.
        const [result] = writer.pragma('wal_checkpoint(RESTART)') as Checkpoint;
        expect(result).toEqual({busy: 1, log: 10, checkpointed: 10});

        // Wait for the commit to be acknowledged before returning. Otherwise
        // teardown terminates the worker mid-COMMIT — and termination cannot
        // interrupt native code, so the WAL write completes after the request
        // and races the unlink on the next line.
        const {
          promise: committed,
          resolve: setCommitted,
          reject: failCommit,
        } = resolver<unknown>();
        worker.once('message', setCommitted);
        // A COMMIT that exceeds the worker's busy_timeout throws there and posts
        // nothing, so without this the wait never settles and the worker's error
        // surfaces separately, attributed to the whole file rather than to this.
        worker.once('error', failCommit);
        worker.postMessage('commit');
        await committed;
        return;
      }

      // Signal the worker to proceed and immediately force a wal_checkpoint.
      worker.postMessage('commit');
      const [result] = writer.pragma('wal_checkpoint(RESTART)') as Checkpoint;
      // With normal transactions, the wal_checkpoint waits for a write to finish.
      expect(result).toEqual({busy: 0, log: 11, checkpointed: 11});

      const {promise: response, resolve: setResponse} = resolver<unknown>();
      worker.once('message', setResponse);
      expect(await response).toEqual({
        before: {count: 13},
        after: {count: 14},
      });

      // New writes should be written from the beginning of the WAL.
      insert.run(20);
      insert.run(21);
      expect(
        (writer.pragma('wal_checkpoint(PASSIVE)') as Checkpoint)[0],
      ).toEqual({busy: 0, log: 2, checkpointed: 2});

      insert.run(22);
      expect(
        (writer.pragma('wal_checkpoint(PASSIVE)') as Checkpoint)[0],
      ).toEqual({busy: 0, log: 1, checkpointed: 1});
    },
  );
});
