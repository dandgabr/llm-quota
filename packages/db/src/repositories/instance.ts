/**
 * Instance setup state (Phase C / ADR-015).
 *
 * `instance_settings` is not readable by the app role; these helpers call the
 * SECURITY DEFINER functions that own the first-run bootstrap lifecycle.
 */

import { sql } from "drizzle-orm";
import type { DB } from "../client.js";

export class PostgresInstanceStore {
  constructor(private readonly db: DB) {}

  /** True while the instance has no completed setup (first run). */
  async setupRequired(opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ required: boolean }>(
      sql`SELECT app_setup_required() AS required`,
    );
    return Boolean(res.rows[0]?.required);
  }

  /** Persist the bootstrap token hash (only while setup is incomplete). */
  async beginBootstrap(hash: string, expiresAt: Date, opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ ok: boolean }>(
      sql`SELECT app_bootstrap_begin(${hash}, ${expiresAt}) AS ok`,
    );
    return Boolean(res.rows[0]?.ok);
  }

  /** True when the hash matches the live bootstrap token (cheap pre-check). */
  async bootstrapValid(hash: string, opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ ok: boolean }>(
      sql`SELECT app_bootstrap_valid(${hash}) AS ok`,
    );
    return Boolean(res.rows[0]?.ok);
  }

  /** Atomically consume the bootstrap token; true exactly once. */
  async consumeBootstrap(hash: string, opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ ok: boolean }>(
      sql`SELECT app_bootstrap_consume(${hash}) AS ok`,
    );
    return Boolean(res.rows[0]?.ok);
  }

  /**
   * Create the first admin atomically (SECURITY DEFINER): validates + consumes
   * the bootstrap token, inserts the account + credential and marks setup
   * complete. Returns the new user id, or null for an invalid token.
   */
  async createFirstAdmin(
    input: {
      tokenHash: string;
      email: string;
      passwordHash: string;
      firstName?: string | null;
      lastName?: string | null;
      locale?: string;
    },
    opts: { db?: DB } = {},
  ): Promise<string | null> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ id: string | null }>(
      sql`SELECT app_setup_first_admin(${input.tokenHash}, ${input.email}, ${input.passwordHash}, ${input.firstName ?? null}, ${input.lastName ?? null}, ${input.locale ?? "en"}) AS id`,
    );
    return res.rows[0]?.id ?? null;
  }

  /** Accept an invite atomically (SECURITY DEFINER). Returns the user id. */
  async acceptInvite(
    input: {
      tokenHash: string;
      passwordHash: string;
      firstName?: string | null;
      lastName?: string | null;
      locale?: string;
    },
    opts: { db?: DB } = {},
  ): Promise<string | null> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ id: string | null }>(
      sql`SELECT app_invite_accept(${input.tokenHash}, ${input.passwordHash}, ${input.firstName ?? null}, ${input.lastName ?? null}, ${input.locale ?? "en"}) AS id`,
    );
    return res.rows[0]?.id ?? null;
  }
}
