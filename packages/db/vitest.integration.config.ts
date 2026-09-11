import { defineConfig } from "vitest/config";

/**
 * Integration config (Phase 8): real Postgres via docker/podman
 * (docker/compose.test.yaml). Files run WITHOUT parallelism because the
 * suites share one database and reset fixtures in beforeAll.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    // Serial: suites share one live DB; parallel resets race each other.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
