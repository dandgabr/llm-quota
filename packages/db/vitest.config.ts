import { defineConfig } from "vitest/config";

/**
 * Unit-test config (default `pnpm test`): fast, no DB required.
 * DB-backed suites live in test/integration and run via `pnpm test:integration`
 * (see vitest.integration.config.ts) so a missing Postgres never breaks units.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/*.test.ts"],
    exclude: ["test/integration/**", "**/node_modules/**", "**/dist/**"],
  },
});
