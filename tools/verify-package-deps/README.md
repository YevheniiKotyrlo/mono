# verify-package-deps

A tool to verify that all internal workspace dependencies are properly declared in `package.json` files across the monorepo.

## Usage

From the workspace root:

```bash
# Check for dependency issues
pnpm run verify-deps

# Check and automatically fix issues
pnpm run verify-deps:fix
```

From this package directory:

```bash
# Check for dependency issues
pnpm run verify

# Check and automatically fix issues
pnpm run verify:fix

# Run this tool's own tests
pnpm run test
```

### Scanning somewhere else

`--root <dir>` (or `--root=<dir>`) points the scan at another workspace, which is
how the smoke tests run the real gate against a fixture containing a known
violation. The directory must contain a `pnpm-workspace.yaml`, and an empty value
is rejected rather than defaulted — otherwise the scan would silently resolve
against the current working directory, and under `--fix` rewrite manifests there.

## What it does

This tool:

1. Scans all TypeScript files in `packages/`, `apps/`, and `tools/` directories
2. Extracts import statements to detect cross-package dependencies
3. Verifies that all used workspace packages are declared in `package.json`
4. Checks for version mismatches between actual and declared versions
5. Identifies unused workspace dependencies
6. Can automatically fix issues with the `--fix` flag

It fails when it finds no TypeScript files at all. This tool signals success by
finding nothing wrong, so an empty scan is indistinguishable from a clean
workspace — a moved directory or a renamed source root would otherwise read as a
pass.

## Ignoring circular dependencies

If you have a legitimate circular dependency that you want to ignore, add a comment:

```typescript
// @circular-dep-ignore
import {something} from '../other-package';
```

or on the previous line:

```typescript
// @circular-dep-ignore
import {something} from '../other-package';
```
