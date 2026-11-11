// oxlint-disable e18e/prefer-static-regex
import {readFileSync} from 'node:fs';

// A path in either platform's shape: a leading separator or a drive prefix,
// which no package name has. `path.isAbsolute` follows the host's rules instead.
const FILE_PATH = /^(?:[/\\]|[A-Za-z]:)/;

const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

/**
 * Whether a module id names a file rather than a package: a relative path, an
 * absolute path on either platform, or a bundler-virtual (`\0`) id.
 */
export function isFileModuleId(id: string): boolean {
  return id.startsWith('.') || FILE_PATH.test(id) || id.startsWith('\0');
}

/** The package a bare module id belongs to, scope included. */
export function packageName(id: string): string {
  const parts = id.split('/');
  return id.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Whether the bundler leaves a module id as an import: every file is bundled,
 * and a package only when it is on the inline list.
 */
export function isExternalModuleId(
  id: string,
  inlinedPackages: ReadonlySet<string>,
): boolean {
  return !isFileModuleId(id) && !inlinedPackages.has(packageName(id));
}

/**
 * Whether a file specifier in build output loads from a consumer's install: a
 * relative path to a module that is not TypeScript source.
 */
export function isResolvableFileSpecifier(id: string): boolean {
  const [path] = id.split(/[?#]/, 1);
  return (
    (path.startsWith('./') || path.startsWith('../')) &&
    !TYPESCRIPT_FILE.test(path)
  );
}

const external = [
  'node:*',
  '@badrap/valita',
  '@rocicorp/datadog-util',
  '@rocicorp/lock',
  '@rocicorp/logger',
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
