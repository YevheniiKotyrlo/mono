import {defineConfig, mergeConfig} from 'vitest/config';
import config from '../../packages/shared/src/tool/vitest-config.ts';

export default mergeConfig(
  config,
  defineConfig({
    test: {
      browser: {
        enabled: false,
      },
      // The plugin entry is a root-level index.js (that path is what
      // oxlint.base.ts loads), so tests sit beside it rather than under src/.
      include: ['*.test.js'],
    },
  }),
);
