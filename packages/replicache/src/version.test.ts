import {expect, test} from 'vitest';
import {version} from './version.ts';

test('version', async () => {
  expect(typeof version).toBe('string');
  const x = await fetch(new URL('../package.json', import.meta.url));
  expect(version).toBe((await x.json()).version);
});
