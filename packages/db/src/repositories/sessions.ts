/**
 * Session repository + RLS principal for the Phase 5 auth middleware.
 *
 * Resolves an opaque session token to a `ResolvedPrincipal` (user id + roles)
 * and emits the `app.*` session settings that the tenant Row-Level Security
 * policies read. Per ADR-005 Q1/Q2, the settings are set transaction-scoped via
 * `SET LOCAL` and are never self-elevated outside the managed transaction. All
 * `app.*` values are set as **strings** ('true'/'false'), which is how Postgres
 * custom GUCs compare (ADR-009 consequence).
 */

import { and, desc, eq, isNull, sql, type InferSelectModel } from "drizzle-orm";
import type { Role } from "@llm-quota/shared";
import { hashToken, verifySessionToken } from "@llm-quota/auth";
import type { DB } from "../client.js";
import { userSessions } from "../schema/history.js";
import { users } from "../schema/auth.js";

export type UserSessionRow = InferSelectModel<typeof userSessions>;

/** A resolved actor: the minimal identity the RLS + RBAC middleware needs. */
export interface ResolvedPrincipal {
  userId: string;
  role: Role;
  isAdmin: boolean;
  isSupervisorAdmin: boolean;
  /** When the current session last passed a step-up reauthentication. */
  stepUpAt?: Date | null;
  /** The resolved session's id + age (for periodic rotation decisions). */
  sessionId?: string;
  sessionCreatedAt?: Date;
  sessionTokenHash?: string;
  /** Absolute expiry of the current lineage (rotation must never extend it). */
  sessionExpiresAt?: Date;
  /** Non-null when the session has already been rotated once (periodic). */
  sessionReplacedBy?: string | null;
}

/** Create a new user session row for an issued token hash. */
export async function createSession(
  db: DB,
  input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    signature?: string;
    lastSeenAt?: Date;
    stepUpAt?: Date | null;
    replacedBy?: string | null;
  },
): Promise<UserSessionRow> {
  const [row] = await db.insert(userSessions).values(input).returning();
  if (!row) throw new Error("Failed to create session");
  return row;
}

/**
 * Resolve a raw session token to a `ResolvedPrincipal` by reading the session
 * row and its user's role. Returns null for unknown/revoked/expired sessions.
 *
 * `signatureSecret` (SESSION_SECRET) enables the defense-in-depth HMAC check:
 * when set and the stored signature mismatches the token, the session is
 * rejected (guards a leaked hash table against forged reuse).
 *
 * Runs in ONE managed transaction that sets the GUCs the app-role pool needs
 * under FORCE RLS: `app.is_auth` for the pre-auth token-hash lookup, then
 * `app.user_id` for the owner read (migration 0003). Under a superuser pool
 * the policies are no-ops, so tests are unaffected.
 */
export async function resolvePrincipal(
  db: DB,
  token: string,
  now: Date = new Date(),
  signatureSecret?: string,
  opts: { idleTtlSeconds?: number; touchIntervalSeconds?: number; graceSeconds?: number } = {},
): Promise<ResolvedPrincipal | null> {
  const idleTtl = opts.idleTtlSeconds ?? 0;
  const touchInterval = opts.touchIntervalSeconds ?? 60;
  const grace = opts.graceSeconds ?? 0;
  const tokenHash = hashToken(token);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.is_auth', 'true', true)`);
    const rows = await tx
      .select()
      .from(userSessions)
      .where(eq(userSessions.tokenHash, tokenHash))
      .limit(1);
    const session = rows[0];
    if (!session) return null;
    if (session.revoked) return null;
    if (now > session.expiresAt) return null;
    // A rotated session is accepted only within its short grace window (covers
    // parallel in-flight requests); afterwards the old token is dead.
    if (session.replacedBy && session.rotatedAt) {
      if (grace <= 0 || now.getTime() > session.rotatedAt.getTime() + grace * 1000) return null;
    }
    if (session.signature) {
      if (!signatureSecret) return null;
      if (!verifySessionToken(token, session.signature, signatureSecret)) return null;
    }
    // Idle timeout: reject a session untouched beyond the TTL.
    if (idleTtl > 0 && now.getTime() - session.lastSeenAt.getTime() > idleTtl * 1000) {
      return null;
    }
    await tx.execute(sql`SELECT set_config('app.user_id', ${session.userId}, true)`);
    const [user] = await tx
      .select({ role: users.role, isActive: users.isActive, deletedAt: users.deletedAt })
      .from(users)
      .where(eq(users.id, session.userId))
      .limit(1);
    // Soft-deleted accounts must not authenticate (deleted_at wins over isActive).
    if (!user || !user.isActive || user.deletedAt) return null;
    // Touch last_seen_at ONLY after the session+user are validated, throttled,
    // under the scoped GUC (pre-principal write for this exact token).
    if (now.getTime() - session.lastSeenAt.getTime() >= touchInterval * 1000) {
      await tx.execute(sql`SELECT set_config('app.is_session_touch', 'true', true)`);
      await tx.execute(sql`SELECT set_config('app.session_touch_hash', ${tokenHash}, true)`);
      await tx.execute(
        sql`UPDATE user_sessions SET last_seen_at = ${now} WHERE token_hash = ${tokenHash} AND revoked = false AND expires_at > now()`,
      );
    }
    return {
      userId: session.userId,
      role: user.role as Role,
      isAdmin: user.role === "admin",
      isSupervisorAdmin: user.role === "supervisor" || user.role === "admin",
      stepUpAt: session.stepUpAt,
      sessionId: session.id,
      sessionCreatedAt: session.createdAt,
      sessionTokenHash: tokenHash,
      sessionExpiresAt: session.expiresAt,
      sessionReplacedBy: session.replacedBy,
    };
  });
}

/**
 * Rotate a session: revoke the old row and insert its replacement in ONE
 * transaction. The `UPDATE ... WHERE revoked = false RETURNING` gate makes the
 * rotation race-safe (only one concurrent caller wins).
 */
export async function rotateSession(
  db: DB,
  oldSessionId: string,
  input: {
    userId: string;
    tokenHash: string;
    signature?: string;
    expiresAt: Date;
    lastSeenAt?: Date;
    stepUpAt?: Date | null;
    /** true = hard-revoke the old row now (explicit rotate); false = grace. */
    immediate?: boolean;
  },
): Promise<{ rotated: boolean; newSessionId: string | null }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${input.userId}, true)`);
    // Mark the old row rotated. `immediate` also revokes it (explicit rotate);
    // otherwise its token keeps a short grace for periodic rotation.
    const now = new Date();
    const claimed = await tx
      .update(userSessions)
      .set({ rotatedAt: now, revoked: input.immediate === true })
      .where(
        and(
          eq(userSessions.id, oldSessionId),
          eq(userSessions.userId, input.userId),
          eq(userSessions.revoked, false),
          isNull(userSessions.replacedBy),
        ),
      )
      .returning({ id: userSessions.id });
    if (claimed.length === 0) return { rotated: false, newSessionId: null };
    const [row] = await tx
      .insert(userSessions)
      .values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        signature: input.signature,
        expiresAt: input.expiresAt,
        lastSeenAt: input.lastSeenAt ?? new Date(),
        stepUpAt: input.stepUpAt ?? null,
      })
      .returning({ id: userSessions.id });
    if (!row) throw new Error("Failed to rotate session");
    await tx
      .update(userSessions)
      .set({ replacedBy: row.id })
      .where(eq(userSessions.id, oldSessionId));
    return { rotated: true, newSessionId: row.id };
  });
}

/** Safe wire projection of a session (never the token hash or signature). */
export interface SessionView {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revoked: boolean;
}

/** List a user's recent sessions (safe DTO; never leaks hashes/signatures). */
export async function listSessionsByUser(
  db: DB,
  userId: string,
  limit = 20,
): Promise<SessionView[]> {
  const rows = await db
    .select({
      id: userSessions.id,
      createdAt: userSessions.createdAt,
      expiresAt: userSessions.expiresAt,
      lastSeenAt: userSessions.lastSeenAt,
      revoked: userSessions.revoked,
    })
    .from(userSessions)
    .where(eq(userSessions.userId, userId))
    .orderBy(desc(userSessions.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
    revoked: r.revoked,
  }));
}

/** Revoke a session (id-scoped), returning the number of rows revoked. */
export async function revokeSession(db: DB, id: string, userId: string): Promise<number> {
  const result = await db
    .update(userSessions)
    .set({ revoked: true })
    .where(and(eq(userSessions.id, id), eq(userSessions.userId, userId)))
    .returning({ id: userSessions.id });
  return result.length;
}

/** Revoke every active session for a user (block/password-reset/MFA reset). */
export async function revokeAllSessionsFor(db: DB, userId: string): Promise<number> {
  const result = await db
    .update(userSessions)
    .set({ revoked: true })
    .where(eq(userSessions.userId, userId))
    .returning({ id: userSessions.id });
  return result.length;
}

/** Revoke a session by its token hash (logout), owner-scoped. */
export async function revokeSessionByToken(db: DB, tokenHash: string, userId: string): Promise<number> {
  const result = await db
    .update(userSessions)
    .set({ revoked: true })
    .where(and(eq(userSessions.tokenHash, tokenHash), eq(userSessions.userId, userId)))
    .returning({ id: userSessions.id });
  return result.length;
}

/** Find a live session row by token hash and owner (rotation lookup). */
export async function findSessionByTokenHash(
  db: DB,
  tokenHash: string,
  userId: string,
): Promise<UserSessionRow | null> {
  const [row] = await db
    .select()
    .from(userSessions)
    .where(and(eq(userSessions.tokenHash, tokenHash), eq(userSessions.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Mark the current session's step-up timestamp (owner-scoped). */
export async function markStepUp(
  db: DB,
  tokenHash: string,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(userSessions)
    .set({ stepUpAt: now })
    .where(and(eq(userSessions.tokenHash, tokenHash), eq(userSessions.userId, userId)));
}

/** Delete revoked/expired sessions older than the retention window. */
export async function sweepSessions(
  db: DB,
  now: Date = new Date(),
  ttlSeconds = 7 * 24 * 3600,
): Promise<number> {
  const rows = await db
    .delete(userSessions)
    .where(
      sql`(${userSessions.revoked} = true OR ${userSessions.expiresAt} < ${now}) AND ${userSessions.createdAt} < ${now}::timestamptz - make_interval(secs => ${ttlSeconds})`,
    )
    .returning({ id: userSessions.id });
  return rows.length;
}

/**
 * Run `fn` inside a managed transaction that sets the `app.*` RLS GUCs for the
 * given principal via `SET LOCAL`. The settings are transaction-scoped, so they
 * never leak to other requests. Values are bound as text and set as strings
 * ('true'/'false'), which is how Postgres custom GUCs compare.
 *
 * `extra` sets additional server-side GUCs (e.g. `app.is_collector` for the
 * collector's cross-tenant enumeration policy). NEVER pass client input here.
 */
export async function withRlsContext<T>(
  db: DB,
  principal: ResolvedPrincipal,
  fn: (tx: DB) => Promise<T>,
  extra: Record<string, string> = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${principal.userId}, true)`);
    await tx.execute(sql`SELECT set_config('app.is_admin', ${String(principal.isAdmin)}, true)`);
    await tx.execute(
      sql`SELECT set_config('app.is_supervisor_admin', ${String(principal.isSupervisorAdmin)}, true)`,
    );
    for (const [key, value] of Object.entries(extra)) {
      await tx.execute(sql`SELECT set_config(${key}, ${value}, true)`);
    }
    return fn(tx);
  });
}
