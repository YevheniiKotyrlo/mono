import {defineConfig, mergeConfig} from 'vitest/config';
import {
  configForCustomPg,
  configForNoPg,
  configForVersion,
} from '../zero-cache/vitest.config.ts';

const {url} = import.meta;

export const projects = [
  // The no-pg project only: merged into a Postgres-backed project, 20s would
  // lower the larger grant pgProjectDefaults() gives it.
  mergeConfig(configForNoPg(url), {test: {testTimeout: 20_000}}),
  configForVersion(15, url),
  configForVersion(16, url),
  configForVersion(17, url),
  configForVersion(18, url),
  ...configForCustomPg(url),
];

// passWithNoTests is a run-level option, so projects can't set it. See
// shared's vitest-config.
export default defineConfig({
  test: {projects, passWithNoTests: true},
});
