/** Workspace directories whose immediate children are packages. */
const PACKAGE_ROOTS = new Set(['packages', 'apps', 'tools']);

/** Either path separator, so Windows and POSIX paths split the same way. */
const SEPARATOR = /[\\/]/;

/**
 * Maps a workspace-relative path to the package that owns it, or undefined when
 * the path is not inside one.
 *
 * Takes an already-relative path so the separator handling is testable without
 * a filesystem: `relative()` returns backslashes on Windows, and splitting on
 * '/' alone produced a single segment there — so this returned undefined for
 * every file and the verification it feeds passed while checking nothing.
 */
export function packageOfRelativePath(
  relativePath: string,
): string | undefined {
  const parts = relativePath.split(SEPARATOR);
  if (parts.length >= 2 && PACKAGE_ROOTS.has(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return undefined;
}
