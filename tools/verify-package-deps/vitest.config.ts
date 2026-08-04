import {defineConfig} from 'vitest/config';

// Standalone: these are pure unit tests over a path predicate, so none of the
// shared browser/database setup applies and reaching across packages for it
// would mean declaring a dependency this tool does not otherwise have.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Matches the shared config's 10s: the smoke tests run the real gate out of
    // process, so vitest's 5s default leaves less margin than anything else here.
    testTimeout: 10_000,
  },
});
