/**
 * Invitation repository (Phase A / ADR-013).
 *
 * Invite tokens are opaque and stored only as a SHA-256 hash. Resolution and
 * acceptance run through the pre-auth `app.is_invite` RLS context (the matching
 * policies are the only grant for those paths on the non-superuser pool).
 */

import { and, desc, eq, isNull, sql, type InferSelectModel } from "drizzle-orm";
import type { Role } from "@llm-quota/shared";
import type { DB } from "../client.js";
import { userInvites, users } from "../schema/auth.js";

export type UserInviteRow = InferSelectModel<typeof userInvites>;

/** Safe wire projection of an invite. */
export interface InviteView {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

function toView(row: UserInviteRow): InviteView {
  return {
    id: row.id,
    email: row.email,
    role: row.role as Role,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class PostgresInviteStore {
  constructor(private readonly db: DB) {}

  /** Create an invite for `email`; `userId` set => password reset for that user. */
  async create(
    input: {
      email: string;
      role: Role;
      tokenHash: string;
      expiresAt: Date;
      invitedBy: string;
      userId?: string | null;
    },
    opts: { db?: DB } = {},
  ): Promise<InviteView> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .insert(userInvites)
      .values({
        email: input.email.trim().toLowerCase(),
        role: input.role,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        invitedBy: input.invitedBy,
        userId: input.userId ?? null,
      })
      .returning();
    if (!row) throw new Error("Failed to create invite");
    return toView(row);
  }

  /** Resolve a live invite by token hash (pre-auth path; needs app.is_invite). */
  async findLiveByTokenHash(
    tokenHash: string,
    opts: { db?: DB } = {},
  ): Promise<UserInviteRow | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select()
      .from(userInvites)
      .where(
        and(
          eq(userInvites.tokenHash, tokenHash),
          isNull(userInvites.acceptedAt),
          isNull(userInvites.revokedAt),
          sql`${userInvites.expiresAt} > now()`,
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Atomically consume an invite. Returns the row when this call accepted it;
   * null when it was already accepted/revoked/expired (race-safe: the UPDATE is
   * the gate, not a prior SELECT).
   */
  async consume(tokenHash: string, opts: { db?: DB } = {}): Promise<UserInviteRow | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .update(userInvites)
      .set({ acceptedAt: new Date() })
      .where(
        and(
          eq(userInvites.tokenHash, tokenHash),
          isNull(userInvites.acceptedAt),
          isNull(userInvites.revokedAt),
          sql`${userInvites.expiresAt} > now()`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Mark an invite as accepted (id-scoped; used after the user row exists). */
  async markAccepted(id: string, opts: { db?: DB } = {}): Promise<void> {
    const handle = opts.db ?? this.db;
    await handle.update(userInvites).set({ acceptedAt: new Date() }).where(eq(userInvites.id, id));
  }

  /** Soft-revoke an invite. Returns false when it was already consumed/revoked. */
  async revoke(id: string, opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .update(userInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(userInvites.id, id), isNull(userInvites.revokedAt), isNull(userInvites.acceptedAt)))
      .returning({ id: userInvites.id });
    return rows.length > 0;
  }

  /** List invites (admin). */
  async list(opts: { limit?: number; db?: DB } = {}): Promise<InviteView[]> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .select()
      .from(userInvites)
      .orderBy(desc(userInvites.createdAt))
      .limit(opts.limit ?? 100);
    return rows.map(toView);
  }

  /** True when a live user already owns this email (invite conflict guard). */
  async emailInUse(email: string, opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select({ id: users.id })
      .from(users)
      .where(and(sql`lower(${users.email}) = lower(${email})`, isNull(users.deletedAt)))
      .limit(1);
    return Boolean(row);
  }
}
