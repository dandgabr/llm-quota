/**
 * Audit trail (Phase B / ADR-014).
 *
 * Append-only: the app role may INSERT and SELECT (admin/supervisor) but the
 * migration revokes UPDATE/DELETE/TRUNCATE. Events are written in the SAME
 * transaction as the mutation they describe, so a failed mutation leaves no
 * orphan event and a successful one is always recorded.
 */

import { index, jsonb, pgEnum, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/**
 * Closed action taxonomy (v1). Kept as text + CHECK in the migration so new
 * values require an explicit migration.
 */
export const auditActionEnum = pgEnum("audit_action", [
  "user.created",
  "user.role_changed",
  "user.blocked",
  "user.unblocked",
  "user.deleted",
  "user.password_reset",
  "invite.created",
  "invite.revoked",
  "invite.accepted",
  "connection.created",
  "connection.updated",
  "connection.deleted",
  "auth.setup_completed",
  "auth.login_succeeded",
  "auth.login_failed",
  "auth.logout",
  "mfa.enrolled",
  "mfa.disabled",
  "mfa.recovery_code_used",
  "mfa.admin_reset",
  "session.revoked",
  "system.retention",
]);

/** An immutable security-relevant event. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").notNull().primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** Actor; NULL for anonymous/system events (e.g. a failed login). */
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Role snapshot (survives later role changes / deletion). */
    actorRole: varchar("actor_role", { length: 20 }),
    action: auditActionEnum("action").notNull(),
    targetType: varchar("target_type", { length: 40 }),
    targetId: varchar("target_id", { length: 128 }),
    /** Sanitized metadata (allowlist keys; never secrets). */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    /** Correlates the event with the request/log line. */
    requestId: varchar("request_id", { length: 128 }),
  },
  (t) => ({
    // Stable keyset cursor (occurred_at DESC, id DESC).
    cursorIdx: index("audit_events_cursor_idx").on(t.occurredAt, t.id),
    actorIdx: index("audit_events_actor_idx").on(t.actorUserId, t.occurredAt),
    targetIdx: index("audit_events_target_idx").on(t.targetType, t.targetId),
  }),
);

export type AuditEventRecord = typeof auditEvents.$inferSelect;
