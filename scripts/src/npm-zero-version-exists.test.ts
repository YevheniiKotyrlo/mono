import {expect, test} from 'vitest';
import {npmZeroVersionExists, type Exec} from './shared.ts';

test('a failure that never reached npm reports its own message and keeps it as the cause', () => {
  const spawnFailure = new Error('spawnSync npm ENOENT');
  const exec: Exec = () => {
    throw spawnFailure;
  };

  let thrown: unknown;
  try {
    npmZeroVersionExists('1.2.3', exec);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe(
    'Could not check npm for @rocicorp/zero@1.2.3: spawnSync npm ENOENT',
  );
  expect((thrown as Error).cause).toBe(spawnFailure);
});
