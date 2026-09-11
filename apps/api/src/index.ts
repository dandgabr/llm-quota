/**
 * llm-quota API entry point.
 *
 * Phase 5 wires the Hono REST app (ADR-008) and exposes config + boot helpers.
 */

export { createApiApp, type ApiAppOptions, type Problem } from "./app.js";

export interface ApiConfig {
  /** HTTP port the API listens on. */
  port: number;
  /** Runtime environment (development | production | test). */
  env: string;
}

/** Default HTTP port when PORT is not set. */
export const defaultPort = 3000;

/** Read API config from the environment. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: env.PORT ? Number(env.PORT) : defaultPort,
    env: env.NODE_ENV ?? "development",
  };
}

/** Boot the HTTP server (Phase 5). Accepts a serve adapter for testability. */
export const start = (): void => {
  // Reserved: attach createApiApp to an HTTP listener (Fase 5 wiring).
};
