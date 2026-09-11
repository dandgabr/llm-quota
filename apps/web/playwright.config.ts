import { defineConfig } from "@playwright/test";

/**
 * Playwright usability suite (Phase 8).
 *
 * Serves the BUILT SPA (vite preview) against a deterministic in-memory API
 * stub, so journeys are hermetic — no live Postgres required. The canonical
 * QUERY/real-DB behaviors are covered by the API wire E2E; here we assert the
 * SPA contract: GET alias (ADR-008), i18n, themes, RBAC gating, a11y.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // the API stub holds shared mutable state; serialize journeys
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"]] : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      // Deterministic seeded API stub (mirrors the Hono contract).
      command: "pnpm exec tsx e2e/support/api-stub.ts",
      url: "http://127.0.0.1:3100/health",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
    {
      // Build with the stub base URL baked in (VITE_API_URL is build-time) and
      // serve the production bundle via vite preview.
      command:
        "VITE_API_URL=http://127.0.0.1:3100 pnpm exec vite build --mode test && pnpm exec vite preview --port 4173 --host 127.0.0.1 --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
