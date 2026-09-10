import {mergeConfig} from 'vitest/config';
import config from './src/tool/vitest-config.ts';

export default mergeConfig(config, {
  test: {
    name: 'shared/browser',
    // These read the filesystem and resolve paths, so they and their tests are
    // node-only.
    exclude: [
      'src/build.test.ts',
      'src/node-shim-command.test.ts',
      'src/logging.test.ts',
      'src/options.test.ts',
    ],
  },
});
