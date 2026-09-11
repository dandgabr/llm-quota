/**
 * Drizzle connection/DB client for llm-quota.
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type DB = NodePgDatabase<typeof schema>;

export { schema };

export interface DbOptions {
  url: string;
  maxConnections?: number;
}

/** Create a Drizzle DB from a pool. Caller owns pool lifecycle. */
export function createDb(options: DbOptions): DB {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.maxConnections ?? 10,
  });
  return drizzle(pool, { schema });
}

export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const url = env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error("DATABASE_URL is required. See .env.example and docs/deploy.md.");
  }
  return { url, maxConnections: env.PG_MAX_CONNECTIONS ? Number(env.PG_MAX_CONNECTIONS) : 10 };
}
