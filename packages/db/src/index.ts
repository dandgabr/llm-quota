/**
 * llm-quota PostgreSQL package — Phase 0 scaffold.
 *
 * Concrete schema (users, profiles/RBAC, identity providers, quota providers,
 * connections, snapshots, sessions, aggregates), migrations, seed and the
 * repository layer are designed in Phase 2. This module currently exposes the
 * reserved package surface so it typechecks and can be depended on.
 */

export interface DatabaseConfig {
  url: string;
  maxConnections?: number;
}

export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const url = env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error(
      "DATABASE_URL is required. See .env.example and docs/deploy.md.",
    );
  }
  return {
    url,
    maxConnections: env.PG_MAX_CONNECTIONS ? Number(env.PG_MAX_CONNECTIONS) : 10,
  };
}
