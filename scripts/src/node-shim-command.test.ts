import {expect, test} from 'vitest';
import {
  isNodeShimCommand,
  NODE_SHIM_ENTRYPOINTS,
  resolveNodeShimCommand,
  type NodeShimCommand,
} from './node-shim-command.ts';

const SHIMS = Object.keys(NODE_SHIM_ENTRYPOINTS) as NodeShimCommand[];
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const present = () => true;
const absent = () => false;

test('every shim is recognised, and nothing else is', () => {
  for (const shim of SHIMS) {
    expect(isNodeShimCommand(shim)).toBe(true);
  }
  // Including a prototype key: `in` answers for those, so a predicate written
  // that way would narrow one to NodeShimCommand and index the map to a
  // function.
  for (const other of [
    'node',
    'git',
    'docker',
    'tar',
    'pnpm',
    'npm.cmd',
    'constructor',
    'toString',
    '__proto__',
  ]) {
    expect(isNodeShimCommand(other)).toBe(false);
  }
});

test.each(SHIMS)('%s passes through untouched on posix', shim => {
  // The shim is a real executable everywhere but Windows, so rewriting it there
  // would break the platform that works.
  expect(
    resolveNodeShimCommand(shim, ['run', 'x'], 'linux', absent, NODE),
  ).toEqual({command: shim, args: ['run', 'x']});
});

// The expected string is Windows-shaped on every host: the resolver takes its
// path grammar from the platform argument, not from the one it runs on.
test.each(SHIMS)('%s runs under node on win32', shim => {
  const resolved = resolveNodeShimCommand(
    shim,
    ['run', 'x'],
    'win32',
    present,
    NODE,
  );
  expect(resolved.command).toBe(NODE);
  expect(resolved.args).toEqual([
    `C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\${NODE_SHIM_ENTRYPOINTS[shim]}`,
    'run',
    'x',
  ]);
});

test.each(SHIMS)('%s throws on win32 when its entrypoint is missing', shim => {
  // Naming the path is the point: the bare-name ENOENT names neither the
  // entrypoint nor the reason the bare name was refused.
  expect(() =>
    resolveNodeShimCommand(shim, [], 'win32', absent, NODE),
  ).toThrowError(
    new RegExp(`expected its entrypoint at .*${NODE_SHIM_ENTRYPOINTS[shim]}`),
  );
});

test('a command outside the map is untouched on win32 too', () => {
  for (const other of ['git', 'docker', 'tar', 'node']) {
    expect(
      resolveNodeShimCommand(other, ['x'], 'win32', present, NODE),
    ).toEqual({
      command: other,
      args: ['x'],
    });
  }
});

test('resolution is deterministic and side-effect free', () => {
  // Same inputs, same output, and the argument array is never mutated — callers
  // pass their own and some reuse it across spawns.
  const args: readonly string[] = Object.freeze(['pack']);
  const first = resolveNodeShimCommand('npm', args, 'win32', present, NODE);
  const second = resolveNodeShimCommand('npm', args, 'win32', present, NODE);
  expect(first).toEqual(second);
  expect(args).toEqual(['pack']);
});

test('an empty argument list resolves to the entrypoint alone', () => {
  const resolved = resolveNodeShimCommand('npx', [], 'win32', present, NODE);
  expect(resolved.args).toEqual([
    'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
  ]);
});
