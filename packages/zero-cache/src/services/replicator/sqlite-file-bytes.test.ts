import {LogContext} from '@rocicorp/logger';
import {expect, test} from 'vitest';
import {TestLogSink} from '../../../../shared/src/logging-test-utils.ts';
import {sqliteFileBytes} from './sqlite-change-log-observability.ts';

function errorWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), {code});
}

function statFrom(
  outcomes: Record<string, number | NodeJS.ErrnoException>,
): Parameters<typeof sqliteFileBytes>[2] {
  return path => {
    const outcome = outcomes[path] ?? errorWithCode('ENOENT');
    return typeof outcome === 'number'
      ? Promise.resolve({size: outcome})
      : Promise.reject(outcome);
  };
}

test('sums the database file and whichever of its sidecars exist, silently skipping the rest', async () => {
  const sink = new TestLogSink();
  const lc = new LogContext('debug', undefined, sink);

  const bytes = await sqliteFileBytes(
    lc,
    'replica.db',
    statFrom({'replica.db': 4096, 'replica.db-wal2': 1024}),
  );

  expect(bytes).toBe(5120);
  expect(sink.messages).toEqual([]);
});

test('warns about a stat failure that is not a missing file, and counts it as zero', async () => {
  const sink = new TestLogSink();
  const lc = new LogContext('debug', undefined, sink);
  const denied = errorWithCode('EACCES');

  const bytes = await sqliteFileBytes(
    lc,
    'replica.db',
    statFrom({'replica.db': 4096, 'replica.db-wal': denied}),
  );

  expect(bytes).toBe(4096);
  expect(sink.messages).toEqual([
    [
      'warn',
      undefined,
      ['unable to stat replica.db-wal for size metrics', denied],
    ],
  ]);
});
