import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 20000,
    hookTimeout: 60000,
    // The test files share one database, so they run one after another.
    fileParallelism: false,
  },
});
