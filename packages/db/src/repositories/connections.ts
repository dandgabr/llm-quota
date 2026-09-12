/**
 * Connections repository: persists a user's provider connection and its
 * secret at rest via envelope encryption (ADR-001 §3, ADR-005 Q5).
 *
 * The plaintext API key / OAuth refresh token is sealed with a fresh DEK and
 * the DEK is wrapped by the KEK (`parseKekFromEnv`) — only the versioned
 * ciphertext string is stored in `connections.secret_cipher`. Secrets are
 * never logged.
 */

import { decryptSecret, encryptSecret, type Dek } from "@llm-quota/core";
import { and, desc, eq, lt, sql, type InferSelectModel } from "drizzle-orm";
import type { DB } from "../client.js";
import { connections, quotaProviders } from "../schema/quotas.js";

export type ConnectionRow = InferSelectModel<typeof connections>;

/** Safe wire projection of a connection (never includes the secret cipher). */
export interface ConnectionView {
  id: string;
  providerKey: string;
  label: string;
  connectionType: "api" | "oauth";
  status: "ok" | "error" | "unconfigured";
  createdAt: string;
}

/** A connection with its decrypted secret exposed in memory (never logged). */
export interface DecryptedConnection extends ConnectionRow {
  secret: string;
}

export interface CreateConnectionInput {
  userId: string;
  providerId: string;
  label: string;
  connectionType: "api" | "oauth";
  /** Plaintext API key / OAuth refresh token to seal at rest. */
  secret: string;
  /** Optional DB handle override (e.g. a transaction from withRlsContext). */
  db?: DB;
}

/** Connection repository backed by Drizzle + Postgres. */
export class PostgresConnectionStore {
  constructor(private readonly db: DB, private readonly kek: Dek) {}

  /** Persist a new connection, sealing its secret with the KEK. */
  async create(input: CreateConnectionInput): Promise<ConnectionRow> {
    const secretCipher = encryptSecret(input.secret, this.kek);
    const handle = input.db ?? this.db;
    const [row] = await handle
      .insert(connections)
      .values({
        userId: input.userId,
        providerId: input.providerId,
        label: input.label,
        connectionType: input.connectionType,
        secretCipher,
      })
      .returning();
    if (!row) throw new Error("Failed to create connection");
    return row;
  }

  /** Load a connection by id, decrypting its secret in memory. */
  async findById(id: string, userId: string): Promise<DecryptedConnection | null> {
    const rows = await this.db
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, userId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return { ...row, secret: decryptSecret(row.secretCipher, this.kek) };
  }

  /**
   * List connections owned by a user (owner-scoped), newest first. Supports a
   * simple cursor via `before` (an updatedAt ISO instant). `opts.db` overrides the
   * handle used (e.g. a transaction from withRlsContext) so RLS GUCs apply.
   */
  async listByUser(
    userId: string,
    opts: { limit?: number; before?: string; db?: DB } = {},
  ): Promise<ConnectionRow[]> {
    const handle = opts.db ?? this.db;
    const limit = opts.limit ?? 50;
    const rows = await handle
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.userId, userId),
          opts.before ? lt(connections.createdAt, new Date(opts.before)) : sql`true`,
        ),
      )
      .orderBy(desc(connections.createdAt))
      .limit(limit);
    return rows;
  }

  /**
   * List a user's connections as SAFE wire DTOs: joins the provider for its
   * `providerKey` and never selects `secretCipher`/`userId`, so ciphertext can
   * never leak through a serialization slip on the API layer.
   */
  async listByUserView(
    userId: string,
    opts: { limit?: number; db?: DB } = {},
  ): Promise<ConnectionView[]> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .select({
        id: connections.id,
        providerKey: quotaProviders.providerKey,
        label: connections.label,
        connectionType: connections.connectionType,
        createdAt: connections.createdAt,
      })
      .from(connections)
      .innerJoin(quotaProviders, eq(connections.providerId, quotaProviders.id))
      .where(eq(connections.userId, userId))
      .orderBy(desc(connections.createdAt))
      .limit(opts.limit ?? 50);
    return rows.map((r) => ({
      id: r.id,
      providerKey: r.providerKey,
      label: r.label,
      connectionType: r.connectionType,
      status: "ok" as const,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * Create a connection and return its SAFE wire DTO (same projection as
   * `listByUserView`), so create + list share one response shape.
   */
  async createAndReturnView(input: CreateConnectionInput): Promise<ConnectionView> {
    const row = await this.create(input);
    const [view] = await this.listByUserView(input.userId, {
      db: input.db ?? this.db,
      limit: 1000,
    }).then((rows) => rows.filter((r) => r.id === row.id));
    if (!view) {
      // Fallback when the view projection cannot be resolved (e.g. provider
      // deleted concurrently): return the minimal safe shape.
      return {
        id: row.id,
        providerKey: input.providerId,
        label: row.label,
        connectionType: row.connectionType,
        status: "ok",
        createdAt: row.createdAt.toISOString(),
      };
    }
    return view;
  }

  /**
   * SYSTEM: enumerate every connection (id + owner) for the quota collector.
   * MUST run inside `withRlsContext(..., { "app.is_collector": "true" })` —
   * the matching FORCE-RLS policy is the only grant for this path.
   */
  async listAllForCollector(opts: { limit?: number; db?: DB } = {}): Promise<
    { id: string; userId: string; providerId: string }[]
  > {
    const handle = opts.db ?? this.db;
    return handle
      .select({ id: connections.id, userId: connections.userId, providerId: connections.providerId })
      .from(connections)
      .limit(opts.limit ?? 1000);
  }

  /** Connector id for a provider row (collector routing), or null. */
  async providerConnectorId(providerId: string, opts: { db?: DB } = {}): Promise<string | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select({ connectorId: quotaProviders.connectorId })
      .from(quotaProviders)
      .where(eq(quotaProviders.id, providerId))
      .limit(1);
    return row?.connectorId ?? null;
  }

  /**
   * Update a connection's label (no secret change). Returns the number of rows
   * updated (0 when not found / not owned), so the API can map to RFC 7807 404.
   */
  async updateLabel(id: string, userId: string, label: string): Promise<number> {
    const result = await this.db
      .update(connections)
      .set({ label, updatedAt: new Date() })
      .where(and(eq(connections.id, id), eq(connections.userId, userId)))
      .returning({ id: connections.id });
    return result.length;
  }

  /**
   * Delete a connection by id (owner-scoped). Returns the number of rows removed
   * (0 when not found / not owned) for RFC 7807 mapping.
   */
  async remove(id: string, userId: string): Promise<number> {
    const result = await this.db
      .delete(connections)
      .where(and(eq(connections.id, id), eq(connections.userId, userId)))
      .returning({ id: connections.id });
    return result.length;
  }
}
