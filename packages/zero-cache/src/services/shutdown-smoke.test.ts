import {resolver} from '@rocicorp/resolver';
import {expect, test} from 'vitest';
import {forkChildWorker, type Worker} from '../types/processes.ts';
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
 *
 * `forkChildWorker` rather than `childWorker`: the latter hands back an
 * in-process channel whenever `SINGLE_PROCESS` is set, which sibling files in
 * this package do — and an in-process channel is exactly what these tests exist
 * to look past. The pid is asserted so that substitution cannot happen silently.
 */

const FIXTURE = new URL('./shutdown-smoke-fixture.ts', import.meta.url);

/** Forks the fixture and resolves once it reports itself ready. */
async function startFixture(): Promise<{
  child: Worker;
  closed: Promise<number | null>;
  /** Resolves once the child answers, proving it is still running. */
  probe: () => Promise<void>;
}> {
  const ready = resolver<void>();
  const closed = resolver<number | null>();

  const child = forkChildWorker(FIXTURE);
  child.onMessageType('ready', () => ready.resolve());
  child.on('close', code => closed.resolve(code));
  child.on('error', err => ready.reject(err));

  await ready.promise;
  // A real OS process, not an in-process channel wearing the same interface.
  expect(child.pid).not.toBe(undefined);

  return {
    child,
    closed: closed.promise,
    probe: () => {
      const answered = resolver<void>();
      child.onceMessageType('status', () => answered.resolve());
      child.send(['status', {status: 'probe'}]);
      return answered.promise;
    },
  };
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
  // and would prove nothing about the request. Proved by a round trip rather than
  // by outlasting a timer: the child answering IS the evidence it is up, and it
  // does not get slower under load the way a deadline does.
  const {child, closed, probe} = await startFixture();

  await probe();

  child.send([...SHUTDOWN_MESSAGE]);
  expect(await closed).toBe(0);
}, 30_000);

test('an unrelated message does not shut the child down', async () => {
  // The channel carries other traffic, so recognising a shutdown too loosely would
  // turn an ordinary message into an outage.
  const {child, closed, probe} = await startFixture();

  child.send(['ready', {ready: true}]);
  child.send(['notify', {}]);

  // Sent after them and answered, so the child processed both and is still up.
  // Ordering is what makes this an observation rather than a race: IPC messages
  // arrive in order, so an answer to the last one places the earlier two behind
  // it.
  await probe();

  child.send([...SHUTDOWN_MESSAGE]);
  expect(await closed).toBe(0);
}, 30_000);
