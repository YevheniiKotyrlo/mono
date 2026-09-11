import {defineConfig, mergeConfig} from 'vitest/config';
import {
  configForCustomPg,
  configForNoPg,
  configForVersion,
} from '../zero-cache/vitest.config.ts';

const {url} = import.meta;

export const projects = [
  // The raise applies to the no-pg project alone. These suites are slower than a
  // typical unit test, so 20s over that project's 10s default is deliberate — but
  // the Postgres-backed projects already carry a larger grant from the shared
  // defaults (30s locally, 60s in CI, because CI is slower), and merging 20s over
  // those LOWERS them. That is the direction that turns a healthy test red under
  // the parallelism the pg projects actually run at.
  mergeConfig(configForNoPg(url), {test: {testTimeout: 20_000}}),
  configForVersion(15, url),
  configForVersion(16, url),
  configForVersion(17, url),
  configForVersion(18, url),
  ...configForCustomPg(url),
];

export default defineConfig({test: {projects}});
