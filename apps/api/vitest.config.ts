import { defineConfig } from "vitest/config";

/**
 * Unit-test config for the API (default `pnpm test`): stubs only, no DB.
 * Live-wire suites live in test/integration (vitest.integration.config.ts).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/*.test.ts"],
    exclude: ["test/integration/**", "**/node_modules/**", "**/dist/**"],
  },
});
