/**
 * Quota snapshots repository: raw point-in-time reads persisted by the
 * collector and served by `GET /v1/quotas` (latest per connection).
 *
 * All reads/writes go through a `withRlsContext` transaction supplied by the
 * caller (`opts.db`), so FORCE RLS tenant isolation applies to every row.
 */

import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "../client.js";
import { quotaSnapshots } from "../schema/quotas.js";

const toNumber = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/** Latest snapshot per connection, mapped for the wire (QuotaView). */
export interface QuotaViewRow {
  id: string;
  connectionId: string;
  kind: "percent" | "credits";
  window: string;
  usedPercent: number;
  remainingPercent: number;
  usedAmount?: number;
  remainingAmount?: number;
  currency?: string;
  resetAt?: string;
  readAt: string;
}

interface SnapshotInsert {
  connectionId: string;
  kind: "percent" | "credits";
  window: "session" | "daily" | "weekly" | "monthly" | "lifetime";
  currency?: string;
  credits?: { used?: number; limit?: number; total?: number };
  usedPercent?: number;
  remainingPercent?: number;
  resetsAt?: Date;
  readAt?: Date;
}

/** Postgres-backed quota snapshot store. */
export class PostgresQuotaStore {
  constructor(private readonly db: DB) {}

  /** Persist one raw snapshot read (collector). */
  async insertSnapshot(input: SnapshotInsert, opts: { db?: DB } = {}): Promise<void> {
    const handle = opts.db ?? this.db;
    await handle.insert(quotaSnapshots).values({
      connectionId: input.connectionId,
      kind: input.kind,
      window: input.window,
      currency: input.currency,
      credits: input.credits,
      usedPercent:
        input.usedPercent === undefined ? null : input.usedPercent.toFixed(3),
      remainingPercent:
        input.remainingPercent === undefined ? null : input.remainingPercent.toFixed(3),
      resetsAt: input.resetsAt,
      ...(input.readAt ? { readAt: input.readAt } : {}),
    });
  }

  /**
   * Latest snapshot per connection and window for a user (DISTINCT ON), joined through
   * connections for owner-scoping. Call inside a withRlsContext transaction.
   */
  async latestPerConnection(
    userId: string,
    opts: { limit?: number; db?: DB } = {},
  ): Promise<QuotaViewRow[]> {
    const handle = opts.db ?? this.db;
    const limit = opts.limit ?? 100;
    const result = await handle.execute(sql`
      SELECT DISTINCT ON (qs.connection_id, qs.window)
        qs.id, qs.connection_id, qs.kind, qs.window, qs.currency, qs.credits,
        qs.used_percent, qs.remaining_percent, qs.resets_at, qs.read_at
      FROM quota_snapshots qs
      INNER JOIN connections c ON c.id = qs.connection_id
      WHERE c.user_id = ${userId}
      ORDER BY qs.connection_id, qs.window, qs.read_at DESC
      LIMIT ${limit}
    `);
    const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows ?? [];
    return rows.map((r) => {
      const credits = (r.credits ?? null) as { used?: number; limit?: number; total?: number } | null;
      return {
        id: String(r.id),
        connectionId: String(r.connection_id),
        kind: r.kind as "percent" | "credits",
        window: String(r.window),
        usedPercent: toNumber(r.used_percent),
        remainingPercent: toNumber(r.remaining_percent),
        usedAmount: credits?.used,
        remainingAmount: credits?.total,
        currency: (r.currency as string | null) ?? undefined,
        resetAt: r.resets_at ? new Date(r.resets_at as string).toISOString() : undefined,
        readAt: new Date(r.read_at as string).toISOString(),
      };
    });
  }

  /** Latest snapshot for one connection (diagnostics/tests). */
  async latestForConnection(
    connectionId: string,
    opts: { db?: DB } = {},
  ): Promise<QuotaViewRow | null> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .select()
      .from(quotaSnapshots)
      .where(eq(quotaSnapshots.connectionId, connectionId))
      .orderBy(desc(quotaSnapshots.readAt))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      connectionId: r.connectionId,
      kind: r.kind,
      window: r.window,
      usedPercent: toNumber(r.usedPercent),
      remainingPercent: toNumber(r.remainingPercent),
      usedAmount: r.credits?.used,
      remainingAmount: r.credits?.total,
      currency: r.currency ?? undefined,
      resetAt: r.resetsAt?.toISOString(),
      readAt: r.readAt.toISOString(),
    };
  }

  /** Latest snapshot for one connection and window. */
  async latestForConnectionAndWindow(
    connectionId: string,
    window: "session" | "daily" | "weekly" | "monthly" | "lifetime",
    opts: { db?: DB } = {},
  ): Promise<QuotaViewRow | null> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .select()
      .from(quotaSnapshots)
      .where(sql`${quotaSnapshots.connectionId} = ${connectionId} AND ${quotaSnapshots.window} = ${window}`)
      .orderBy(desc(quotaSnapshots.readAt))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      connectionId: r.connectionId,
      kind: r.kind,
      window: r.window,
      usedPercent: toNumber(r.usedPercent),
      remainingPercent: toNumber(r.remainingPercent),
      usedAmount: r.credits?.used,
      remainingAmount: r.credits?.total,
      currency: r.currency ?? undefined,
      resetAt: r.resetsAt?.toISOString(),
      readAt: r.readAt.toISOString(),
    };
  }
}
