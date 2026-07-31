/** Workspace directories whose immediate children are packages. */
const PACKAGE_ROOTS = new Set(['packages', 'apps', 'tools']);

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
  if (parts.length >= 2 && PACKAGE_ROOTS.has(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return undefined;
}
