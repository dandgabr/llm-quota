/**
 * llm-quota API — Phase 0 scaffold.
 *
 * The real HTTP server, REST routes, auth and collectors are wired in later
 * phases. For now this exposes a small typed config helper so the package
 * typechecks and is testable.
 */

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

/** Reserved hook to boot the HTTP server (Phase 5+). */
export const start = (): void => {
  // Reserved: boot HTTP server (Phase 5+).
};
