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

/** A managed DB handle: the Drizzle database plus lifecycle control. */
export interface DbHandle {
  db: DB;
  pool: pg.Pool;
  /** Release all pooled connections (call on app shutdown / test teardown). */
  close(): Promise<void>;
}

/** Create a Drizzle DB from a pool. Caller owns pool lifecycle. */
export function createDb(options: DbOptions): DbHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.maxConnections ?? 10,
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env) {
  const url = env.DATABASE_URL ?? "";
  if (!url) {
    throw new Error("DATABASE_URL is required. See .env.example and docs/deploy.md.");
  }
  return { url, maxConnections: env.PG_MAX_CONNECTIONS ? Number(env.PG_MAX_CONNECTIONS) : 10 };
}
