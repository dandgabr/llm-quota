/**
 * Audit repository (Phase B / ADR-014).
 *
 * `recordAudit` runs inside the SAME transaction as the mutation it describes.
 * It sanitizes metadata to an allowlist so secrets can never reach the trail.
 */

import { and, asc, desc, eq, lt, or, sql, type InferSelectModel } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { DB } from "../client.js";
import { auditEvents } from "../schema/audit.js";

export type AuditEventRow = InferSelectModel<typeof auditEvents>;

export type AuditAction = AuditEventRow["action"];

/** An audit event to persist; the actor comes from the RLS context. */
export interface AuditInput {
  action: AuditAction;
  /** Actor id; omit for anonymous/system events (`app.is_audit` required). */
  actorUserId?: string | null;
  actorRole?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

/** Safe wire projection of an audit event. */
export interface AuditView {
  id: string;
  occurredAt: string;
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  requestId: string | null;
}

/**
 * Keys that must never appear in audit metadata (defense-in-depth). Matches
 * secret words anywhere (`secret`, `token`, `password`, `hash`, ...) plus the
 * credential-key variants (`apiKey`, `api_key`), without stripping innocuous
 * camelCase like `providerKey`.
 */
const SECRET_KEY = /(secret|token|password|passwd|hash|authorization|api[_-]?key)/i;

/** Recursively redact secret-looking keys and cap string lengths. */
export function sanitizeMetadata(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 5) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = sanitizeValue(v, depth);
  }
  return out;
}

function sanitizeValue(v: unknown, depth: number): unknown {
  if (typeof v === "string") return v.slice(0, 500);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => sanitizeValue(x, depth + 1));
  if (typeof v === "object") return sanitizeMetadata(v as Record<string, unknown>, depth + 1);
  return undefined;
}

/** Deterministic JSON with recursively sorted keys (jsonb does not preserve order). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Deterministic SHA-256 over the chained event material (tamper-evidence). */
export function computeEventHash(
  prevHash: string | null,
  input: AuditInput,
  metadata: Record<string, unknown>,
): string {
  const canonical = stableStringify({
    prev: prevHash,
    action: input.action,
    actor: input.actorUserId ?? null,
    actorRole: input.actorRole ?? null,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    metadata,
    requestId: input.requestId ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function toView(row: AuditEventRow): AuditView {
  return {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata ?? {},
    requestId: row.requestId,
  };
}

export interface AuditQuery {
  actorUserId?: string;
  action?: string;
  targetType?: string;
  from?: Date;
  to?: Date;
  /** Keyset cursor: return events strictly before this (occurred_at, id). */
  beforeOccurredAt?: Date;
  beforeId?: string;
  limit?: number;
}

export class PostgresAuditStore {
  constructor(private readonly db: DB) {}

  /** Append one event (call inside the mutation's transaction). */
  async record(input: AuditInput, opts: { db?: DB } = {}): Promise<void> {
    const handle = opts.db ?? this.db;
    const metadata = sanitizeMetadata(input.metadata ?? {});
    // Tamper-evidence chain: serialize writers and link to the previous hash.
    await handle.execute(sql`SELECT pg_advisory_xact_lock(hashtext('llm-quota:audit'))`);
    const [prev] = await handle
      .select({ eventHash: auditEvents.eventHash })
      .from(auditEvents)
      .orderBy(desc(auditEvents.seq))
      .limit(1);
    const prevHash = prev?.eventHash ?? null;
    await handle.insert(auditEvents).values({
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata,
      requestId: input.requestId ?? null,
      prevHash,
      eventHash: computeEventHash(prevHash, input, metadata),
    });
  }

  /** Keyset-paginated read (admin/supervisor; caller sets the RLS context). */
  async list(query: AuditQuery, opts: { db?: DB } = {}): Promise<{ data: AuditView[]; nextCursor: string | null }> {
    const handle = opts.db ?? this.db;
    const limit = Math.min(Math.max(1, query.limit ?? 50), 200);
    const conditions = [];
    if (query.actorUserId) conditions.push(eq(auditEvents.actorUserId, query.actorUserId));
    if (query.action) conditions.push(eq(auditEvents.action, query.action as AuditAction));
    if (query.targetType) conditions.push(eq(auditEvents.targetType, query.targetType));
    if (query.from) conditions.push(sql`${auditEvents.occurredAt} >= ${query.from}`);
    if (query.to) conditions.push(sql`${auditEvents.occurredAt} <= ${query.to}`);
    if (query.beforeOccurredAt && query.beforeId) {
      conditions.push(
        or(
          lt(auditEvents.occurredAt, query.beforeOccurredAt),
          and(
            eq(auditEvents.occurredAt, query.beforeOccurredAt),
            lt(auditEvents.id, query.beforeId),
          ),
        )!,
      );
    }
    const rows = await handle
      .select()
      .from(auditEvents)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? `${last.occurredAt.toISOString()}|${last.id}` : null;
    return { data: page.map(toView), nextCursor };
  }

  /**
   * Recompute the hash chain oldest→newest and report the first break. A
   * `brokenAt` means an event was altered, deleted or reordered.
   */
  async verifyChain(opts: { db?: DB } = {}): Promise<{ ok: boolean; checked: number; brokenAt: string | null }> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .select()
      .from(auditEvents)
      .orderBy(asc(auditEvents.seq));
    let prevHash: string | null = null;
    for (const row of rows) {
      // Events written before the chain existed (no event_hash) are legacy;
      // skip them so the chain is verified from the first chained event on.
      if (!row.eventHash) {
        prevHash = null;
        continue;
      }
      if ((row.prevHash ?? null) !== prevHash) return { ok: false, checked: rows.length, brokenAt: row.id };
      const expected = computeEventHash(
        prevHash,
        {
          action: row.action,
          actorUserId: row.actorUserId,
          actorRole: row.actorRole,
          targetType: row.targetType,
          targetId: row.targetId,
          requestId: row.requestId,
        },
        row.metadata ?? {},
      );
      if (row.eventHash !== expected) return { ok: false, checked: rows.length, brokenAt: row.id };
      prevHash = row.eventHash;
    }
    return { ok: true, checked: rows.length, brokenAt: null };
  }

  /**
   * Delete audit events older than the retention window through the
   * SECURITY DEFINER `app_audit_sweep` (the app role is append-only, so it
   * cannot DELETE directly). Call under the collector GUC.
   */
  async sweepViaFunction(retentionDays: number, opts: { db?: DB } = {}): Promise<number> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ n: number }>(
      sql`SELECT app_audit_sweep(${retentionDays}) AS n`,
    );
    return res.rows[0]?.n ?? 0;
  }

  /** Delete audit events older than the retention window (the only app path). */
  async sweep(retentionDays: number, now: Date = new Date()): Promise<number> {
    const rows = await this.db.execute<{ id: string }>(
      sql`DELETE FROM audit_events WHERE occurred_at < ${now} - make_interval(days => ${retentionDays}) RETURNING id`,
    );
    return rows.rows.length;
  }
}
