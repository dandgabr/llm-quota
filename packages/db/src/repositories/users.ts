/**
 * User-management repository (Phase A / ADR-013).
 *
 * Credentials live in `user_credentials` and are NEVER selected into the wire
 * projection (`UserView`). Business guards that must be atomic (last active
 * admin, owner-scoped mutation) run inside the same transaction as the write.
 */

import { and, desc, eq, isNull, ne, sql, type InferSelectModel } from "drizzle-orm";
import type { Role } from "@llm-quota/shared";
import type { DB } from "../client.js";
import { userCredentials, users } from "../schema/auth.js";
import { spendingAggregates, userSessions } from "../schema/history.js";
import { connections } from "../schema/quotas.js";

export type UserRow = InferSelectModel<typeof users>;

/** Safe wire projection of a user (never includes any credential material). */
export interface UserView {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: Role;
  locale: string;
  isActive: boolean;
  hasPassword: boolean;
  createdAt: string;
}

const userViewColumns = {
  id: users.id,
  email: users.email,
  firstName: users.firstName,
  lastName: users.lastName,
  role: users.role,
  locale: users.locale,
  isActive: users.isActive,
  hasPassword: sql<boolean>`(${userCredentials.passwordHash} IS NOT NULL)`,
  createdAt: users.createdAt,
};

/** Advisory lock key serializing last-admin guards across replicas. */
const LAST_ADMIN_LOCK = 0x1a2b3c4;

function toView(row: {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: string;
  locale: string;
  isActive: boolean;
  hasPassword: boolean | null;
  createdAt: Date;
}): UserView {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role as Role,
    locale: row.locale,
    isActive: row.isActive,
    hasPassword: Boolean(row.hasPassword),
    createdAt: row.createdAt.toISOString(),
  };
}

export class PostgresUserStore {
  constructor(private readonly db: DB) {}

  /** Create a user + optional credential in one transaction. */
  async create(
    input: {
      email: string;
      role: Role;
      firstName?: string | null;
      lastName?: string | null;
      locale?: string;
      passwordHash?: string | null;
      emailVerifiedAt?: Date | null;
    },
    opts: { db?: DB } = {},
  ): Promise<UserView> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .insert(users)
      .values({
        email: input.email.trim().toLowerCase(),
        role: input.role,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        locale: input.locale ?? "en",
        emailVerifiedAt: input.emailVerifiedAt ?? null,
      })
      .returning();
    if (!row) throw new Error("Failed to create user");
    if (input.passwordHash) {
      await handle
        .insert(userCredentials)
        .values({ userId: row.id, passwordHash: input.passwordHash, passwordUpdatedAt: new Date() });
    }
    return toView({ ...row, hasPassword: Boolean(input.passwordHash) });
  }

  /** Find a live user by normalized email (for pre-auth login lookup). */
  async findByEmail(
    email: string,
    opts: { db?: DB } = {},
  ): Promise<{ id: string; email: string; role: Role; isActive: boolean; passwordHash: string | null } | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select({
        id: users.id,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        passwordHash: userCredentials.passwordHash,
      })
      .from(users)
      .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
      .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.deletedAt)))
      .limit(1);
    if (!row) return null;
    return { ...row, role: row.role as Role };
  }

  /** List live users (admin/supervisor read). */
  async list(opts: { limit?: number; db?: DB } = {}): Promise<UserView[]> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .select(userViewColumns)
      .from(users)
      .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
      .where(isNull(users.deletedAt))
      .orderBy(desc(users.createdAt))
      .limit(opts.limit ?? 100);
    return rows.map(toView);
  }

  /** Find a live user by id. */
  async findById(id: string, opts: { db?: DB } = {}): Promise<UserView | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select(userViewColumns)
      .from(users)
      .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);
    return row ? toView(row) : null;
  }

  /** Count active admins (for the last-admin guard). */
  async countActiveAdmins(opts: { db?: DB; excludeUserId?: string } = {}): Promise<number> {
    const handle = opts.db ?? this.db;
    const conditions = [eq(users.role, "admin"), eq(users.isActive, true), isNull(users.deletedAt)];
    if (opts.excludeUserId) conditions.push(ne(users.id, opts.excludeUserId));
    const [row] = await handle
      .select({ count: sql<number>`count(*)::int` })
      .from(users)
      .where(and(...conditions));
    return row?.count ?? 0;
  }

  /** Change a user's role. Caller must hold the admin RLS GUC. */
  async updateRole(id: string, role: Role, opts: { db?: DB } = {}): Promise<UserView | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .update(users)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .returning();
    return row ? toView({ ...row, hasPassword: null }) : null;
  }

  /** Set a user's active flag (block/unblock). Caller holds admin RLS GUC. */
  async setActive(id: string, isActive: boolean, opts: { db?: DB } = {}): Promise<UserView | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .update(users)
      .set({ isActive, updatedAt: new Date() })
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .returning();
    return row ? toView({ ...row, hasPassword: null }) : null;
  }

  /**
   * Soft-delete a user: mark inactive + deleted_at, revoke every session. Keeps
   * financial/audit history intact (ADR-013). Purge is a separate operation.
   */
  async softDelete(id: string, opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .update(users)
      .set({ isActive: false, deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (rows.length === 0) return false;
    await handle.update(userSessions).set({ revoked: true }).where(eq(userSessions.userId, id));
    return true;
  }

  /** Count a user's owned connections + spending aggregates (purge guard). */
  async ownedResourceCounts(
    id: string,
    opts: { db?: DB } = {},
  ): Promise<{ connections: number; aggregates: number }> {
    const handle = opts.db ?? this.db;
    const [conn] = await handle
      .select({ count: sql<number>`count(*)::int` })
      .from(connections)
      .where(eq(connections.userId, id));
    const [agg] = await handle
      .select({ count: sql<number>`count(*)::int` })
      .from(spendingAggregates)
      .where(eq(spendingAggregates.userId, id));
    return { connections: conn?.count ?? 0, aggregates: agg?.count ?? 0 };
  }

  /** Replace a user's password hash + revoke all their sessions. */
  async setPassword(
    id: string,
    passwordHash: string,
    opts: { db?: DB } = {},
  ): Promise<void> {
    const handle = opts.db ?? this.db;
    await handle
      .insert(userCredentials)
      .values({ userId: id, passwordHash, passwordUpdatedAt: new Date() })
      .onConflictDoUpdate({
        target: userCredentials.userId,
        set: { passwordHash, passwordUpdatedAt: new Date(), updatedAt: new Date() },
      });
    await handle.update(userSessions).set({ revoked: true }).where(eq(userSessions.userId, id));
  }

  /** Acquire the advisory lock that serializes last-admin guards. */
  async lockLastAdminGuard(tx: DB): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LAST_ADMIN_LOCK})`);
  }
}
