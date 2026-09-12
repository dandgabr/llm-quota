/**
 * Idempotency ledger (Phase A / ADR-013).
 *
 * A retried non-idempotent request with the same `(userId, key)` replays the
 * stored response instead of executing again. In-flight requests are rejected
 * with a conflict; a reused key with a different request hash is rejected.
 */

import { and, eq, lt, sql, type InferSelectModel } from "drizzle-orm";
import type { DB } from "../client.js";
import { idempotencyKeys } from "../schema/auth.js";

export type IdempotencyRow = InferSelectModel<typeof idempotencyKeys>;

export interface IdempotencyClaim {
  /** The row now owned by this request (in-flight) or a completed record. */
  kind: "claimed" | "replay" | "conflict" | "hash_mismatch";
  status?: number;
  body?: string;
}

export class PostgresIdempotencyStore {
  constructor(private readonly db: DB) {}

  /**
   * Atomically claim `key`. Returns:
   *  - `claimed`: caller owns the key and must store its response afterwards.
   *  - `replay`: a completed response exists for an identical request.
   *  - `conflict`: a request with the same key is still in flight.
   *  - `hash_mismatch`: the key was reused with a different request payload.
   */
  async claim(
    userId: string,
    key: string,
    requestHash: string,
    ttlSeconds: number,
    opts: { db?: DB } = {},
  ): Promise<IdempotencyClaim> {
    const handle = opts.db ?? this.db;
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const inserted = await handle
      .insert(idempotencyKeys)
      .values({ userId, key, requestHash, expiresAt })
      .onConflictDoNothing({ target: [idempotencyKeys.userId, idempotencyKeys.key] })
      .returning({ userId: idempotencyKeys.userId });
    if (inserted.length > 0) return { kind: "claimed" };
    const [existing] = await handle
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!existing) return { kind: "claimed" };
    if (existing.requestHash !== requestHash) return { kind: "hash_mismatch" };
    if (existing.responseStatus === null) return { kind: "conflict" };
    return { kind: "replay", status: existing.responseStatus, body: existing.responseBody ?? undefined };
  }

  /** Store the completed response for a claimed key. */
  async complete(
    userId: string,
    key: string,
    status: number,
    body: string,
    opts: { db?: DB } = {},
  ): Promise<void> {
    const handle = opts.db ?? this.db;
    await handle
      .update(idempotencyKeys)
      .set({ responseStatus: status, responseBody: body })
      .where(and(eq(idempotencyKeys.userId, userId), eq(idempotencyKeys.key, key)));
  }

  /** Release a claim whose request failed, so the client may retry. */
  async release(userId: string, key: string, opts: { db?: DB } = {}): Promise<void> {
    const handle = opts.db ?? this.db;
    await handle
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.userId, userId),
          eq(idempotencyKeys.key, key),
          sql`${idempotencyKeys.responseStatus} IS NULL`,
        ),
      );
  }

  /** Delete expired rows (sweep). */
  async sweep(now: Date = new Date()): Promise<number> {
    const rows = await this.db
      .delete(idempotencyKeys)
      .where(lt(idempotencyKeys.expiresAt, now))
      .returning({ userId: idempotencyKeys.userId });
    return rows.length;
  }
}
