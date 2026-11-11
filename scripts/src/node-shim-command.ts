import {existsSync} from 'node:fs';
import * as path from 'node:path';
import type {Command} from './shared.ts';

export type ResolvedCommand = {
  readonly command: string;
  readonly args: readonly string[];
};

/**
 * How to run `command` without a shell. On Windows `npm` is `npm.cmd`, which
 * CreateProcess does not run, so the npm bundled beside the running Node runs
 * under that Node instead; every other command runs as named. The Windows path
 * is built with `path.win32`, so it is the same string on any host.
 */
export function resolveNodeShimCommand(
  command: Command,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
  nodePath: string = process.execPath,
): ResolvedCommand {
  if (platform !== 'win32' || command !== 'npm') {
    return {command, args};
  }
  const {dirname, join} = path.win32;
  const entrypoint = join(
    dirname(nodePath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  if (!fileExists(entrypoint)) {
    throw new Error(
      `Cannot run npm on Windows: expected its entrypoint at ${entrypoint}.`,
    );
  }
  return {command: nodePath, args: [entrypoint, ...args]};
}
