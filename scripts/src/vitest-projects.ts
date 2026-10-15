/** Which of a directory's vitest configs the default test run should use. */

const CONFIG = /^vitest\.config.*\.ts$/u;

/** A suffixed config names a variant: `vitest.config.no-pg.ts`, `.pg-16`, `.web`. */
const SUFFIXED = /^vitest\.config\.[^.]+\.ts$/u;

/** Bench configs run separately, via `pnpm run bench`. */
function isBench(name: string): boolean {
  return name.includes('.bench');
}

export function isVitestConfig(name: string): boolean {
  return CONFIG.test(name);
}

/**
 * The configs in one directory that become projects.
 *
 * Where a directory declares variants, they replace the base config rather than
 * joining it — running both would run every test twice. But a bench config is not
 * a variant of the default run: it is skipped, so it must not be what displaces
 * the base config either. A package whose only suffixed config is a bench would
 * otherwise contribute NO project, and every test in it would stop running with
 * nothing to say so.
 *
 * `isRoot` drops the repo's own config, which would recurse into itself.
 */
export function selectProjectConfigs(
  configNames: readonly string[],
  isRoot = false,
): string[] {
  const hasVariant = configNames.some(
    name => SUFFIXED.test(name) && !isBench(name),
  );
  return configNames.filter(name => {
    if (isBench(name)) {
      return false;
    }
    if (name === 'vitest.config.ts') {
      return !isRoot && !hasVariant;
    }
    return true;
  });
}
