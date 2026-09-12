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

import { and, desc, eq, sql, type InferSelectModel } from "drizzle-orm";
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
}

/** Create a new user session row for an issued token hash. */
export async function createSession(
  db: DB,
  input: { userId: string; tokenHash: string; expiresAt: Date; signature?: string },
): Promise<UserSessionRow> {
  const [row] = await db.insert(userSessions).values(input).returning();
  if (!row) throw new Error("Failed to create session");
  return row;
}

/** Resolve a raw token to a session row by its hash, if valid and not revoked/expired. */
async function findSessionByToken(
  db: DB,
  token: string,
  now: Date = new Date(),
): Promise<UserSessionRow | null> {
  const rows = await db
    .select()
    .from(userSessions)
    .where(eq(userSessions.tokenHash, hashToken(token)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.revoked) return null;
  if (now > row.expiresAt) return null;
  return row;
}

/**
 * Resolve a raw session token to a `ResolvedPrincipal` by reading the session
 * row and its user's role. Returns null for unknown/revoked/expired sessions.
 *
 * `signatureSecret` (SESSION_SECRET) enables the defense-in-depth HMAC check:
 * when set and the stored signature mismatches the token, the session is
 * rejected (guards a leaked hash table against forged reuse).
 */
export async function resolvePrincipal(
  db: DB,
  token: string,
  now: Date = new Date(),
  signatureSecret?: string,
): Promise<ResolvedPrincipal | null> {
  const session = await findSessionByToken(db, token, now);
  if (!session) return null;
  if (session.signature) {
    if (!signatureSecret) return null;
    if (!verifySessionToken(token, session.signature, signatureSecret)) return null;
  }
  const [user] = await db
    .select({ role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);
  if (!user || !user.isActive) return null;
  return {
    userId: session.userId,
    role: user.role as Role,
    isAdmin: user.role === "admin",
    isSupervisorAdmin: user.role === "supervisor" || user.role === "admin",
  };
}

/** List a user's recent sessions (for "active sessions" / revoke UI). */
export async function listSessionsByUser(
  db: DB,
  userId: string,
  limit = 20,
): Promise<UserSessionRow[]> {
  return db
    .select()
    .from(userSessions)
    .where(eq(userSessions.userId, userId))
    .orderBy(desc(userSessions.createdAt))
    .limit(limit);
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
