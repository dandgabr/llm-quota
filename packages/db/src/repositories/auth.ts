/**
 * Authentication repository (Phase D / ADR-016).
 *
 * Covers local login building blocks: credential lookup by email (pre-auth),
 * TOTP enrollment/verification with anti-replay, single-use recovery codes and
 * short-lived MFA challenges. Pre-principal calls run under the narrow
 * `app.is_auth` / `app.is_auth_challenge` GUCs set by the caller's transaction.
 */

import { and, eq, isNull, sql, type InferSelectModel } from "drizzle-orm";
import { decryptSecret, encryptSecret, type Dek } from "@llm-quota/core";
import type { DB } from "../client.js";
import {
  authChallenges,
  mfaRecoveryCodes,
  totpSecrets,
  userCredentials,
  users,
} from "../schema/auth.js";

export type AuthChallengeRow = InferSelectModel<typeof authChallenges>;

/** A credential row paired with the account's basic auth state. */
export interface CredentialLookup {
  userId: string;
  email: string;
  role: string;
  isActive: boolean;
  deletedAt: Date | null;
  passwordHash: string | null;
}

export class PostgresAuthStore {
  constructor(private readonly db: DB, private readonly kek: Dek) {}

  /**
   * Look up credentials by email for the pre-auth login step. Runs under
   * `app.is_auth` + `app.auth_email` (migration 0006 policies).
   */
  async findByEmail(email: string, opts: { db?: DB } = {}): Promise<CredentialLookup | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select({
        userId: users.id,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
        passwordHash: userCredentials.passwordHash,
      })
      .from(users)
      .leftJoin(userCredentials, eq(userCredentials.userId, users.id))
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);
    if (!row) return null;
    return {
      userId: row.userId,
      email: row.email,
      role: row.role,
      isActive: row.isActive,
      deletedAt: row.deletedAt,
      passwordHash: row.passwordHash ?? null,
    };
  }

  /** Look up a user's auth state by id (role/isActive), owner-scoped. */
  async findById(
    userId: string,
    opts: { db?: DB } = {},
  ): Promise<{ userId: string; email: string; role: string; isActive: boolean; deletedAt: Date | null } | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select({
        userId: users.id,
        email: users.email,
        role: users.role,
        isActive: users.isActive,
        deletedAt: users.deletedAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) return null;
    return { ...row, role: row.role };
  }

  // ---- TOTP enrollment ----------------------------------------------------

  /** Read the (decrypted) TOTP secret for a user, if any. */
  async getTotpSecret(userId: string, opts: { db?: DB } = {}): Promise<{ secret: string; verified: boolean; lastUsedStep: number | null } | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select()
      .from(totpSecrets)
      .where(eq(totpSecrets.userId, userId))
      .limit(1);
    if (!row) return null;
    return {
      secret: decryptSecret(row.secretCipher, this.kek),
      verified: row.verifiedAt !== null,
      lastUsedStep: row.lastUsedStep,
    };
  }

  /** Store/replace the (encrypted) TOTP secret, unverified. */
  async setTotpSecret(userId: string, secret: string, opts: { db?: DB } = {}): Promise<void> {
    const handle = opts.db ?? this.db;
    const cipher = encryptSecret(secret, this.kek);
    await handle
      .insert(totpSecrets)
      .values({ userId, secretCipher: cipher })
      .onConflictDoNothing();
    await handle
      .update(totpSecrets)
      .set({ secretCipher: cipher, verifiedAt: null, lastUsedStep: null })
      .where(eq(totpSecrets.userId, userId));
  }

  /**
   * Mark the TOTP secret verified and advance `last_used_step` atomically.
   * Returns false when the step is not newer than the stored one (replay/lost
   * race), so the caller can reject the code.
   */
  async verifyTotpSecret(userId: string, step: number, opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .update(totpSecrets)
      .set({ verifiedAt: new Date(), lastUsedStep: step })
      .where(
        and(
          eq(totpSecrets.userId, userId),
          sql`(${totpSecrets.lastUsedStep} IS NULL OR ${totpSecrets.lastUsedStep} < ${step})`,
        ),
      )
      .returning({ id: totpSecrets.id });
    return rows.length > 0;
  }

  /** Delete a user's TOTP secret (MFA disabled / admin reset). */
  async deleteTotpSecret(userId: string, opts: { db?: DB } = {}): Promise<void> {
    const handle = opts.db ?? this.db;
    await handle.delete(totpSecrets).where(eq(totpSecrets.userId, userId));
  }

  // ---- Recovery codes -----------------------------------------------------

  /** Replace a user's recovery codes with fresh hashes. */
  async setRecoveryCodes(userId: string, hashes: string[], opts: { db?: DB } = {}): Promise<void> {
    const handle = opts.db ?? this.db;
    await handle.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    if (hashes.length) {
      await handle.insert(mfaRecoveryCodes).values(hashes.map((codeHash) => ({ userId, codeHash })));
    }
  }

  /** Consume a recovery code once; returns true when it matched an unused code. */
  async consumeRecoveryCode(userId: string, codeHash: string, opts: { db?: DB } = {}): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(mfaRecoveryCodes.userId, userId),
          eq(mfaRecoveryCodes.codeHash, codeHash),
          isNull(mfaRecoveryCodes.usedAt),
        ),
      )
      .returning({ id: mfaRecoveryCodes.id });
    return rows.length > 0;
  }

  // ---- Login challenges ---------------------------------------------------

  /** Create a short-lived login MFA challenge for a user. */
  async createChallenge(
    userId: string,
    method: string,
    ttlSeconds: number,
    opts: { db?: DB } = {},
  ): Promise<string> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .insert(authChallenges)
      .values({ userId, method, expiresAt: new Date(Date.now() + ttlSeconds * 1000) })
      .returning({ id: authChallenges.id });
    if (!row) throw new Error("Failed to create challenge");
    return row.id;
  }

  /**
   * Resolve a challenge's owner OUTSIDE RLS (SECURITY DEFINER). Needed because
   * the MFA step must know the user before it can scope `app.challenge_user_id`.
   */
  async challengeOwner(id: string, opts: { db?: DB } = {}): Promise<string | null> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ user_id: string | null }>(
      sql`SELECT app_challenge_user(${id}) AS user_id`,
    );
    return res.rows[0]?.user_id ?? null;
  }

  /**
   * Load a challenge for the pre-auth MFA step (runs under
   * `app.is_auth_challenge` + `app.challenge_user_id`).
   */
  async getChallenge(id: string, opts: { db?: DB } = {}): Promise<AuthChallengeRow | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select()
      .from(authChallenges)
      .where(eq(authChallenges.id, id))
      .limit(1);
    return row ?? null;
  }

  /** Atomically consume a live challenge; null when used/expired/unknown. */
  async consumeChallenge(id: string, opts: { db?: DB } = {}): Promise<AuthChallengeRow | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .update(authChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(authChallenges.id, id),
          isNull(authChallenges.consumedAt),
          sql`${authChallenges.expiresAt} > now()`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Increment the attempt counter (throttles MFA brute force). */
  async bumpAttempts(id: string, opts: { db?: DB } = {}): Promise<number> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .update(authChallenges)
      .set({ attempts: sql`${authChallenges.attempts} + 1` })
      .where(eq(authChallenges.id, id))
      .returning({ attempts: authChallenges.attempts });
    return row?.attempts ?? 0;
  }

  /** Sweep expired challenges (collector maintenance). */
  async sweepChallenges(now: Date = new Date()): Promise<number> {
    const rows = await this.db
      .delete(authChallenges)
      .where(sql`${authChallenges.expiresAt} < ${now}`)
      .returning({ id: authChallenges.id });
    return rows.length;
  }
}
