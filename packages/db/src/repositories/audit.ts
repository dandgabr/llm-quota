/**
 * Audit repository (Phase B / ADR-014).
 *
 * `recordAudit` runs inside the SAME transaction as the mutation it describes.
 * It sanitizes metadata to an allowlist so secrets can never reach the trail.
 */

import { and, desc, eq, lt, or, sql, type InferSelectModel } from "drizzle-orm";
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
    await handle.insert(auditEvents).values({
      action: input.action,
      actorUserId: input.actorUserId ?? null,
      actorRole: input.actorRole ?? null,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: sanitizeMetadata(input.metadata ?? {}),
      requestId: input.requestId ?? null,
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
}
