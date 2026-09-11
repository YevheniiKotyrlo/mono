import {mergeConfig} from 'vitest/config';
import config from './src/tool/vitest-config.ts';

export default mergeConfig(config, {
  test: {
    name: 'shared/browser',
    // build.ts reads the filesystem and resolves paths, so it and its test are
    // node-only.
    exclude: [
      'src/build.test.ts',
      'src/logging.test.ts',
      'src/options.test.ts',
    ],
  },
});
