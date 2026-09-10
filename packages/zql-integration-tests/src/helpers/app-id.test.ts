import {expect, test} from 'vitest';
import {appIdFor} from './app-id.ts';

// The app id names the replication slot initial sync creates. Two suites that end
// up with the same id share one slot, and whichever runs second fails setup with
// `replication slot "…_0_a" already exists` — which is exactly what happened when
// this was a hardcoded constant.

test('an already slot-safe name is used unchanged', () => {
  expect(appIdFor('collate_test')).toBe('collate_test');
  expect(appIdFor('pagila_planner_exec')).toBe('pagila_planner_exec');
});

test('a name is rewritten to what slot names allow', () => {
  for (const name of ['collate-test', 'Collate.Test', 'text semantics']) {
    expect(appIdFor(name)).toMatch(/^[a-z0-9_]+$/u);
  }
});

test('names that differ only in separator or case stay distinct', () => {
  // Sanitising alone collapses all of these onto `collate_test`. That is the
  // collision the hardcoded id caused, so the property worth pinning is not "the
  // id is safe" but "distinct databases get distinct ids".
  const names = [
    'collate_test',
    'collate-test',
    'collate.test',
    'Collate-Test',
    'collate--test',
  ];
  expect(new Set(names.map(appIdFor)).size).toBe(names.length);
});

test('ids stay within the room a slot name leaves for suffixes', () => {
  // Postgres truncates a slot name at 63 bytes rather than rejecting it, and
  // callers append `_<shard>_<role>`.
  const longest = appIdFor('a-very-long-suite-name-'.repeat(10));
  expect(longest.length).toBeLessThanOrEqual(49);
  expect(longest).toMatch(/^[a-z0-9_]+$/u);
});

test('long names stay distinct once truncated', () => {
  // Truncation is the other way to lose injectivity: these two agree well past
  // the length bound, so only the digest separates them.
  const prefix = 'a_very_long_but_already_slot_safe_suite_name';
  expect(prefix.length).toBeGreaterThan(40);
  expect(appIdFor(`${prefix}_one`)).not.toBe(appIdFor(`${prefix}_two`));
  expect(appIdFor(`${prefix}_one`).length).toBeLessThanOrEqual(49);
});

test('the two suites that collided now differ', () => {
  expect(appIdFor('collate-test')).not.toBe(appIdFor('text-semantics-test'));
});
