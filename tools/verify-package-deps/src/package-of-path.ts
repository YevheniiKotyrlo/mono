/** Workspace directories whose immediate children are packages. */
export const PACKAGE_ROOTS = ['packages', 'apps', 'tools'] as const;

const PACKAGE_ROOT_SET: ReadonlySet<string> = new Set(PACKAGE_ROOTS);
const EITHER_SEPARATOR = /[\\/]/;

/**
 * The package owning a workspace-relative path, as `root/name`, or undefined
 * outside one. `relative()` joins with the host's separator, so both are split.
 */
export function packageOfRelativePath(
  relativePath: string,
): string | undefined {
  const parts = relativePath.split(EITHER_SEPARATOR);
  if (parts.length >= 2 && PACKAGE_ROOT_SET.has(parts[0])) {
    return `${parts[0]}/${parts[1]}`;
  }
  return undefined;
}
