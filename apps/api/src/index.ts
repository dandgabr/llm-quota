/**
 * llm-quota API entry point.
 *
 * Phase 5 wires the Hono REST app (ADR-008); Phase 7 adds the real HTTP server
 * bootstrap (TLS 1.3, CORS, audit logging) via `server.ts`.
 */

export { createApiApp, type ApiAppOptions, type Problem } from "./app.js";
export { buildServer, start, corsOnce, auditLogger, type ServerConfig, type Started } from "./server.js";

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
