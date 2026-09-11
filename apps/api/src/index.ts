/**
 * llm-quota API — Phase 0 scaffold.
 *
 * The real HTTP server, REST routes, auth and collectors are wired in later
 * phases. For now this exposes a small typed config helper so the package
 * typechecks and is testable.
 */

export interface ApiConfig {
  port: number;
  env: string;
}

export const defaultPort = 3000;

export function readConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  return {
    port: env.PORT ? Number(env.PORT) : defaultPort,
    env: env.NODE_ENV ?? "development",
  };
}

export const start = (): void => {
  // Reserved: boot HTTP server (Phase 5+).
};
