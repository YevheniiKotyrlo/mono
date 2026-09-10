// oxlint-disable e18e/prefer-static-regex
import {readFileSync} from 'node:fs';

/**
 * A filesystem path in either platform's shape: a leading separator (`/x`,
 * `\\server\share`) or a drive prefix (`C:\x`, `C:/x`, and the drive-relative
 * `C:x`).
 *
 * Deliberately not `path.isAbsolute`, which resolves to the *host* platform's
 * rules: on POSIX it answers `false` for `C:\…`, so a Windows-shaped id would be
 * misclassified and the behaviour could only ever be tested on Windows.
 *
 * A bare package specifier cannot match this. The drive prefix is unambiguous
 * because a single letter followed by `:` is not a legal package name, and the
 * scheme-like specifiers that do contain a colon (`node:fs`, `data:…`, `http:…`)
 * all have more than one character before it.
 */
const FILE_PATH = /^(?:[/\\]|[A-Za-z]:)/;

/**
 * True when a bundler module id points at a file rather than naming a package:
 * a relative path, a filesystem path, or a bundler-virtual id (`\0`-prefixed).
 *
 * The path case matters because a leading-slash test answers "not a file" for
 * every first-party module on Windows, so a bundler deciding externality from it
 * externalizes the whole program: the output becomes pass-through stubs that
 * re-export source paths, and the build still reports success.
 */
export function isFileModuleId(id: string): boolean {
  return id.startsWith('.') || FILE_PATH.test(id) || id.startsWith('\0');
}

/**
 * The package a bare module id belongs to, scope included.
 *
 * Only meaningful for ids that name a package — `isFileModuleId` decides that
 * first, so a filesystem path never reaches here.
 */
export function packageName(id: string): string {
  const parts = id.split('/');
  return id.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Whether the bundler should leave a module id as an import instead of bundling
 * it: files are always bundled, and a package is bundled only when it is on the
 * inline list.
 *
 * This is the decision itself rather than its parts, so a test covers what the
 * build actually asks. Reverting the file check alone leaves every test passing
 * while the build emits stubs.
 */
export function isExternalModuleId(
  id: string,
  inlinedPackages: ReadonlySet<string>,
): boolean {
  if (isFileModuleId(id)) {
    return false;
  }
  return !inlinedPackages.has(packageName(id));
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
