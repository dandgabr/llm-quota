import { defineConfig } from "vitest/config";

/**
 * Integration config for the API (Phase 8): boots the real server against the
 * real test Postgres. Serialized: suites share one database.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
