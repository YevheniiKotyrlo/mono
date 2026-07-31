import {defineConfig} from 'vitest/config';

// Standalone: these are pure unit tests over a path predicate, so none of the
// shared browser/database setup applies and reaching across packages for it
// would mean declaring a dependency this tool does not otherwise have.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
