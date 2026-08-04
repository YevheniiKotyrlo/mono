import {resolver} from '@rocicorp/resolver';
import {expect, test} from 'vitest';
import {childWorker, type Worker} from '../types/processes.ts';
import {SHUTDOWN_MESSAGE} from './life-cycle.ts';

/**
 * Smoke tests for asking a real forked process to shut down.
 *
 * The unit tests next door drive `ProcessManager` with a fake emitter, which
 * cannot catch the thing that actually varies: whether the request survives a
 * real IPC channel, and whether the child really exits. That distinction is the
 * whole point on Windows, where Node delivers no `SIGTERM` and `kill('SIGTERM')`
 * terminates a process without running any of its shutdown — so a signal cannot
 * be used to prove the graceful path at all.
 */

const FIXTURE = new URL('./shutdown-smoke-fixture.ts', import.meta.url);

/** Forks the fixture and resolves once it reports itself ready. */
async function startFixture(): Promise<{
  child: Worker;
  closed: Promise<number | null>;
}> {
  const ready = resolver<void>();
  const closed = resolver<number | null>();

  const child = childWorker(FIXTURE);
  child.onMessageType('ready', () => ready.resolve());
  child.on('close', code => closed.resolve(code));
  child.on('error', err => ready.reject(err));

  await ready.promise;
  return {child, closed: closed.promise};
}

test('a shutdown request over IPC exits the child cleanly', async () => {
  const {child, closed} = await startFixture();

  child.send([...SHUTDOWN_MESSAGE]);

  // Zero, not merely "exited": the caller distinguishes a drained shutdown from a
  // killed one by the code, and the integration suites assert on it.
  expect(await closed).toBe(0);
}, 30_000);

test('the child stays up until it is asked', async () => {
  // Otherwise the case above would pass against a process that exits on its own,
  // and would prove nothing about the request.
  const {child, closed} = await startFixture();

  const exitedEarly = await Promise.race([
    closed.then(() => true),
    new Promise<false>(resolve => setTimeout(resolve, 750, false)),
  ]);
  expect(exitedEarly).toBe(false);

  child.send([...SHUTDOWN_MESSAGE]);
  expect(await closed).toBe(0);
}, 30_000);

test('an unrelated message does not shut the child down', async () => {
  // The channel carries other traffic, so recognising a shutdown too loosely would
  // turn an ordinary message into an outage.
  const {child, closed} = await startFixture();

  child.send(['ready', {ready: true}]);
  child.send(['status', {status: 'ok'}]);

  const exited = await Promise.race([
    closed.then(() => true),
    new Promise<false>(resolve => setTimeout(resolve, 750, false)),
  ]);
  expect(exited).toBe(false);

  child.send([...SHUTDOWN_MESSAGE]);
  expect(await closed).toBe(0);
}, 30_000);
