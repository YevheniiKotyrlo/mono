/**
 * Workspace directories whose immediate children are packages.
 *
 * Exported because the scan and the attribution below have to agree on it. Stated
 * twice, a directory added to one and not the other produces this file's own bug:
 * files are found, none is attributed to a package, and the gate reports that
 * every dependency is declared.
 */
export const PACKAGE_ROOTS = ['packages', 'apps', 'tools'] as const;

const PACKAGE_ROOT_SET: ReadonlySet<string> = new Set(PACKAGE_ROOTS);

/** Either path separator, so Windows and POSIX paths split the same way. */
const SEPARATOR = /[\\/]/;

/**
 * Maps a workspace-relative path to the package that owns it, or undefined when
 * the path is not inside one.
 *
 * Takes an already-relative path so the separator handling is testable without a
 * filesystem. The input comes from `relative()`, whose separator follows the host,
 * so both are recognised: a split that reads only one attributes nothing, and an
 * unattributed file is skipped rather than reported.
 */
export function packageOfRelativePath(
  relativePath: string,
): string | undefined {
  // Empty segments are dropped so a trailing or doubled separator cannot read as
  // a package name: such a key matches no real package, and an unmatched key
  // exempts the file rather than reporting it.
  const parts = relativePath.split(SEPARATOR).filter(Boolean);
  if (parts.length >= 2 && PACKAGE_ROOT_SET.has(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return undefined;
}
