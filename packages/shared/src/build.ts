// oxlint-disable e18e/prefer-static-regex
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';

/**
 * True when a bundler module id points at a file rather than naming a package:
 * a relative path, an absolute path, or a bundler-virtual id (`\0`-prefixed).
 *
 * `isAbsolute` rather than a leading-slash test, because on Windows an absolute
 * id is `C:\…` or `C:/…`. A leading-slash test answers "not a file" for every
 * first-party module there, so a bundler that decides externality from it
 * externalizes the whole program: the output becomes pass-through stubs that
 * re-export source paths, and the build still reports success.
 */
export function isFileModuleId(id: string): boolean {
  return id.startsWith('.') || isAbsolute(id) || id.startsWith('\0');
}

const external = [
  'node:*',
  '@badrap/valita',
  '@rocicorp/datadog-util',
  '@rocicorp/lock',
  '@rocicorp/logger',
  '@rocicorp/resolver',
  'replicache',
];

export function sharedOptions(
  minify: boolean | undefined = true,
  metafile: boolean | undefined = false,
) {
  const opts = {
    bundle: true,
    target: 'es2022',
    format: 'esm',
    external,
    minify,
    sourcemap: true,
    metafile,
  } as const;
  if (minify) {
    return /** @type {const} */ {
      ...opts,
      mangleProps: /^_./,
      reserveProps: /^__.*__$/,
    } as const;
  }
  return opts;
}

function getVersion(name: string): string {
  const url = new URL(`../../${name}/package.json`, import.meta.url);
  const s = readFileSync(url, 'utf-8');
  return JSON.parse(s).version;
}

export function makeDefine(
  mode: 'debug' | 'release' | 'unknown' = 'unknown',
): Record<string, string> {
  /** @type {Record<string, string>} */
  const define: Record<string, string> = {
    ['process.env.REPLICACHE_VERSION']: JSON.stringify(
      getVersion('replicache'),
    ),
    ['process.env.ZERO_VERSION']: JSON.stringify(getVersion('zero')),
    ['process.env.DISABLE_MUTATION_RECOVERY']: 'false',
    ['process.env.DISABLE_REPLICACHE_INDEXES']: 'false',
  };
  if (mode === 'unknown') {
    return define;
  }
  return {
    ...define,
    'process.env.NODE_ENV': mode === 'debug' ? '"development"' : '"production"',
  };
}
