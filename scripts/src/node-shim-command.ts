import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';

/**
 * The commands Windows implements as a `.CMD` shim and Node ships beside itself.
 *
 * The value is the JS entrypoint npm installs for each, which is what actually
 * runs. Declared as a map rather than a set so adding a shim states where its
 * entrypoint is, and so the two facts cannot drift apart.
 */
export const NODE_SHIM_ENTRYPOINTS = {
  npm: 'npm-cli.js',
  npx: 'npx-cli.js',
} as const;

export type NodeShimCommand = keyof typeof NODE_SHIM_ENTRYPOINTS;

export type ResolvedCommand = {
  readonly command: string;
  readonly args: readonly string[];
};

export function isNodeShimCommand(command: string): command is NodeShimCommand {
  return command in NODE_SHIM_ENTRYPOINTS;
}

/**
 * How to actually run one of those commands, per platform.
 *
 * On Windows `npm` is `npm.cmd` and `CreateProcess` only ever appends `.exe`, so
 * spawning it by name throws ENOENT. `shell: true` does resolve the shim, at the
 * cost of concatenating arguments rather than escaping them (Node DEP0190) — and
 * these arguments carry filesystem paths. So the shim's own JS entrypoint runs
 * under the current Node instead.
 *
 * Everything else passes through untouched: `docker`, `git`, `tar` and `node`
 * are real executables on Windows, and a command outside the map above is not
 * this function's business.
 *
 * When the expected layout does not hold, this throws naming the path it looked
 * for. Returning the bare name would hand back the one invocation the function
 * exists to avoid, and the ENOENT that produces names neither the entrypoint's
 * location nor this decision.
 *
 * Pure given its inputs: the platform, the existence probe and the Node binary
 * are all parameters, so both branches are reachable from either host.
 */
export function resolveNodeShimCommand(
  command: string,
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
  nodePath: string = process.execPath,
): ResolvedCommand {
  if (platform !== 'win32' || !isNodeShimCommand(command)) {
    return {command, args};
  }
  const entrypoint = join(
    dirname(nodePath),
    'node_modules',
    'npm',
    'bin',
    NODE_SHIM_ENTRYPOINTS[command],
  );
  if (!fileExists(entrypoint)) {
    throw new Error(
      `Cannot run ${command} on Windows: expected its entrypoint at ` +
        `${entrypoint}. Spawning '${command}' by name cannot work here — it is ` +
        `${command}.cmd, which CreateProcess will not resolve.`,
    );
  }
  return {command: nodePath, args: [entrypoint, ...args]};
}
