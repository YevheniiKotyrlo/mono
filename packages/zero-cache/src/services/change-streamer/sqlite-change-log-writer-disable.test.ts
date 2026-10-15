import {existsSync} from 'node:fs';
import {LogContext} from '@rocicorp/logger';
import {afterEach, expect, test} from 'vitest';
import {TestLogSink} from '../../../../shared/src/logging-test-utils.ts';
import {deleteLiteDB} from '../../db/delete-lite-db.ts';
import {DbFile} from '../../test/lite.ts';
import type {ChangeStreamData} from '../change-source/protocol/current/downstream.ts';
import {EMPTY_COOKIE_SET} from '../replicator/change-log-cookies.ts';
import {
  CHANGE_LOG_STREAM_TABLE,
  changeLogFileName,
  deleteChangeLogDB,
  openChangeLogDB,
  type ChangeLogIdentity,
} from '../replicator/change-log-db.ts';
import {ReplicationMessages} from '../replicator/test-utils.ts';
import {serializeChangeStreamData} from './change-log-codec.ts';
import {SQLiteChangeLogWriter} from './sqlite-change-log-writer.ts';

const messages = new ReplicationMessages({foo: 'id'});

const IDENTITY: ChangeLogIdentity = {
  epoch: null,
  generation: '01',
  replicaID: 'replica-id',
};

const files: DbFile[] = [];

afterEach(() => {
  let file: DbFile | undefined;
  while ((file = files.pop())) {
    deleteChangeLogDB(file.path);
    deleteLiteDB(file.path);
  }
});

/**
 * A writer whose next write fails: its stream table is dropped out from under
 * the prepared statements, so the write takes the fail-soft path.
 */
function writerFailingNextWrite(name: string, onDisabled: () => void) {
  const sink = new TestLogSink();
  const lc = new LogContext('debug', undefined, sink);
  const file = new DbFile(name);
  files.push(file);
  const writer = new SQLiteChangeLogWriter(lc, {
    replicaFile: file.path,
    identity: IDENTITY,
    onDisabled,
    now: () => 1_700_000_000_000,
  });
  writer.reconcile({resumeWatermark: '02', cookies: EMPTY_COOKIE_SET});
  {
    using other = openChangeLogDB(lc, file.path, {readonly: false});
    other.exec(`DROP TABLE "${CHANGE_LOG_STREAM_TABLE}"`);
  }
  return {
    writer,
    changeLogFile: changeLogFileName(file.path),
    errors: () =>
      sink.messages
        .filter(([level]) => level === 'error')
        .map(([, , args]) => String(args[0])),
    [Symbol.dispose]() {
      writer.close();
    },
  };
}

/** Drives a whole transaction through the writer, as the stream loop does. */
function transaction(writer: SQLiteChangeLogWriter, watermark: string) {
  const write = (change: ChangeStreamData) =>
    writer.write(change, serializeChangeStreamData(change));
  write(['begin', messages.begin(), {commitWatermark: watermark}]);
  write(['data', messages.insert('foo', {id: watermark})]);
  write(['commit', messages.commit(), {watermark}]);
}

test('the disable callback runs before the change log is deleted', () => {
  // The callback closes the catchup reader, which holds its own handle on the
  // file, and Windows refuses to unlink an open file. POSIX allows it, so this
  // asserts the order rather than the outcome, which only Windows would show.
  let existedWhenDisabled: boolean | undefined;
  using fixture = writerFailingNextWrite('change-log-disable-order', () => {
    existedWhenDisabled = existsSync(fixture.changeLogFile);
  });

  transaction(fixture.writer, '04');

  expect(existedWhenDisabled).toBe(true);
  expect(existsSync(fixture.changeLogFile)).toBe(false);
});

test('a throwing disable callback still leaves the change log deleted', () => {
  using fixture = writerFailingNextWrite('change-log-disable-throws', () => {
    throw new Error('closing catchup failed');
  });

  expect(() => transaction(fixture.writer, '04')).not.toThrow();
  expect(existsSync(fixture.changeLogFile)).toBe(false);
  expect(fixture.errors().join('\n')).toContain('error disabling catchup');
  // Replication continues, which is the point of failing soft.
  expect(fixture.writer.enabled).toBe(false);
  expect(() => transaction(fixture.writer, '06')).not.toThrow();
});
