import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/**/*.test.ts'],
    // watch.test.ts drives a real chokidar poller against a temp directory; running test files
    // concurrently caused it to intermittently miss filesystem events under the fs churn from
    // other files' temp-dir setup/teardown (mkdtempSync/rmSync) sharing the same tmp root.
    fileParallelism: false,
  },
});
