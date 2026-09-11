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
import { and, eq, type InferSelectModel } from "drizzle-orm";
import type { DB } from "../client.js";
import { connections } from "../schema/quotas.js";

export type ConnectionRow = InferSelectModel<typeof connections>;

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
}

/** Connection repository backed by Drizzle + Postgres. */
export class PostgresConnectionStore {
  constructor(private readonly db: DB, private readonly kek: Dek) {}

  /** Persist a new connection, sealing its secret with the KEK. */
  async create(input: CreateConnectionInput): Promise<ConnectionRow> {
    const secretCipher = encryptSecret(input.secret, this.kek);
    const [row] = await this.db
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
