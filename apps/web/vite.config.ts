import { fileURLToPath, URL } from "node:url";
import { defineConfig, type UserConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const config = {
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  /**
   * Unit tests (jsdom): pure logic only. Browser journeys live in e2e/ and run
   * via `pnpm exec playwright test` (see playwright.config.ts). Typed loosely:
   * vitest's bundled vite types differ from the workspace vite version.
   */
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["e2e/**", "**/node_modules/**", "**/dist/**"],
  },
};

export default defineConfig(config as UserConfig);
