/** Workspace directories whose immediate children are packages. */
const PACKAGE_ROOTS = new Set(['packages', 'apps', 'tools']);

/** Either path separator, so Windows and POSIX paths split the same way. */
const SEPARATOR = /[\\/]/;

/**
 * Maps a workspace-relative path to the package that owns it, or undefined when
 * the path is not inside one.
 *
 * Takes an already-relative path, so the separator handling is testable without a
 * filesystem — the input arrives from `relative()`, whose separator follows the
 * host, and a split that recognises only one of them attributes nothing. Every
 * file then falls outside every package, which the verification downstream reads
 * as nothing to check rather than as a failure.
 */
export function packageOfRelativePath(
  relativePath: string,
): string | undefined {
  // Empty segments are dropped, so a trailing or doubled separator cannot be
  // mistaken for a package name: 'packages/' and 'packages//zero/a.ts' both
  // yielded 'packages/' otherwise, which is then matched against real package
  // names, finds nothing, and silently exempts those files from verification —
  // the same failure this module exists to prevent.
  const parts = relativePath.split(SEPARATOR).filter(Boolean);
  if (parts.length >= 2 && PACKAGE_ROOTS.has(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return undefined;
}
