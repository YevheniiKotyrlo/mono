import {readFile} from 'node:fs/promises';
import {resolve as resolvePath} from 'node:path';
import {fileURLToPath} from 'node:url';
import {packageUp} from 'package-up';
import {isInternalPackage} from './internal-packages.ts';

export async function getExternalFromPackageJSON(
  basePath: string,
  includePeerDeps = false,
): Promise<string[]> {
  const cwd = basePath.startsWith('file:') ? fileURLToPath(basePath) : basePath;
  const path = await packageUp({cwd});

  if (!path) {
    throw new Error('Could not find package.json');
  }
  const x = await readFile(path, 'utf-8');
  const pkg = JSON.parse(x);

  const deps: Set<string> = new Set();
  for (const dep of Object.keys({
    ...pkg.dependencies,
    ...(includePeerDeps ? pkg.peerDependencies : {}),
  })) {
    if (isInternalPackage(dep)) {
      for (const depDep of await getRecursiveExternals(dep, includePeerDeps)) {
        deps.add(depDep);
      }
    } else {
      deps.add(dep);
    }
  }
  return [...deps];
}

function getRecursiveExternals(
  name: string,
  includePeerDeps: boolean,
): Promise<string[]> {
  if (name === 'shared') {
    // fileURLToPath, not `.pathname`: that yields '/C:/…' on Windows, which then
    // fails the `startsWith('file:')` test above, skips conversion, and sends a
    // nonexistent path to packageUp.
    return getExternalFromPackageJSON(
      fileURLToPath(import.meta.url),
      includePeerDeps,
    );
  }
  const depPath = resolvePath(`../${name}`);

  return getExternalFromPackageJSON(depPath, includePeerDeps);
}
