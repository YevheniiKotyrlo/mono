import type {execFileSync} from 'node:child_process';
import {expect, test} from 'vitest';
import {createExec} from './shared.ts';

// The node path is injected along with the platform, so these assert the same
// literal on every runner. `node-shim-command.test.ts` covers the resolver
// itself, including the throw; what is left here is the chokepoint.
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const NPM_CLI = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

function recordingExecFile(
  calls: {command: string; args: readonly string[]}[],
) {
  return ((command: string, args: readonly string[]) => {
    calls.push({command, args});
    return '';
  }) as unknown as typeof execFileSync;
}

test('the exec chokepoint routes through resolveNodeShimCommand', () => {
  // The command has to be one whose resolution actually differs, or the
  // assertion holds whether the routing happened or not.
  const calls: {command: string; args: readonly string[]}[] = [];
  const exec = createExec({
    execFile: recordingExecFile(calls),
    platform: 'win32',
    fileExists: () => true,
    nodePath: NODE,
  });

  exec('npm', ['pack', '--json'], {});

  expect(calls).toEqual([{command: NODE, args: [NPM_CLI, 'pack', '--json']}]);
});

test('the exec chokepoint leaves a real executable alone', () => {
  const calls: {command: string; args: readonly string[]}[] = [];
  const exec = createExec({
    execFile: recordingExecFile(calls),
    platform: 'win32',
    nodePath: NODE,
  });

  exec('git', ['status'], {});

  expect(calls).toEqual([{command: 'git', args: ['status']}]);
});
