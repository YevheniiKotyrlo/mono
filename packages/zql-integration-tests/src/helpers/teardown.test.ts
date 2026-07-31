import {expect, test, vi} from 'vitest';
import {releaseAll} from './teardown.ts';

test('runs every step when they all succeed', async () => {
  const order: string[] = [];
  await releaseAll([() => order.push('a'), () => order.push('b')]);
  expect(order).toEqual(['a', 'b']);
});

test('runs the later steps after an earlier one throws', async () => {
  // The defect this exists for: a straight-line teardown skips the database drop
  // when closing a handle throws, leaking the database and its replication slot.
  const dropped = vi.fn();
  await expect(
    releaseAll([
      () => {
        throw new Error('socket already closed');
      },
      dropped,
    ]),
  ).rejects.toThrow('socket already closed');
  expect(dropped).toHaveBeenCalledOnce();
});

test('awaits asynchronous steps before starting the next', async () => {
  const order: string[] = [];
  await releaseAll([
    async () => {
      await Promise.resolve();
      order.push('slow');
    },
    () => order.push('fast'),
  ]);
  // Ordering matters for teardown: ending a pool before dropping its database is
  // not the same as doing both at once.
  expect(order).toEqual(['slow', 'fast']);
});

test('collects a rejected promise, not just a synchronous throw', async () => {
  const dropped = vi.fn();
  await expect(
    releaseAll([() => Promise.reject(new Error('pool ended')), dropped]),
  ).rejects.toThrow('pool ended');
  expect(dropped).toHaveBeenCalledOnce();
});

test('reports a single failure as itself rather than wrapping it', async () => {
  // Wrapping one failure in an AggregateError buries the message the runner shows.
  const only = new Error('the only problem');
  await expect(
    releaseAll([
      () => {
        throw only;
      },
    ]),
  ).rejects.toBe(only);
});

test('reports every failure, with the first in the message', async () => {
  let caught: unknown;
  try {
    await releaseAll([
      () => {
        throw new Error('first');
      },
      () => {
        throw new Error('second');
      },
    ]);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AggregateError);
  const aggregate = caught as AggregateError;
  expect(aggregate.errors).toHaveLength(2);
  // Both are reachable, and the message names the first: a bare "2 steps failed"
  // makes the reader open the errors array to learn anything at all.
  expect(aggregate.message).toContain('first');
  expect(aggregate.errors.map(e => (e as Error).message)).toEqual([
    'first',
    'second',
  ]);
});

test('describes a thrown non-error in the message', async () => {
  let caught: unknown;
  try {
    await releaseAll([
      () => {
        // eslint-disable-next-line no-throw-literal
        throw 'not an error';
      },
      () => {
        throw new Error('second');
      },
    ]);
  } catch (error) {
    caught = error;
  }
  expect((caught as AggregateError).message).toContain('not an error');
});

test('does nothing, and throws nothing, for no steps', async () => {
  await expect(releaseAll([])).resolves.toBeUndefined();
});
