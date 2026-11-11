import {expect, test} from 'vitest';
import {resolveNodeShimCommand} from './node-shim-command.ts';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NPM_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';
const present = () => true;
const absent = () => false;

test('on Windows npm runs its entrypoint under the running Node', () => {
  expect(
    resolveNodeShimCommand('npm', ['pack', '--json'], 'win32', present, NODE),
  ).toEqual({command: NODE, args: [NPM_CLI, 'pack', '--json']});
});

test.each([
  ['npm', 'linux'],
  ['npm', 'darwin'],
  ['git', 'win32'],
  ['tar', 'win32'],
] as const)('%s on %s runs as named', (command, platform) => {
  expect(
    resolveNodeShimCommand(command, ['x'], platform, absent, NODE),
  ).toEqual({command, args: ['x']});
});

test('on Windows a missing npm entrypoint fails naming where it looked', () => {
  expect(() =>
    resolveNodeShimCommand('npm', [], 'win32', absent, NODE),
  ).toThrow(NPM_CLI);
});
