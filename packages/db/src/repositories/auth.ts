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
  authLoginAttempts,
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

  /**
   * Verify a raw recovery code by matching its versioned HMAC against every
   * unused code in constant time (no early return), trying MULTIPLE candidate
   * hashes (current + previous pepper during rotation), then consume the matched
   * row atomically. Versioning lets a pepper rotate without invalidating codes;
   * HMAC codes cannot be rehashed without their plaintext, so verification
   * against the previous pepper is the rotation mechanism.
   */
  async consumeRecoveryCode(
    userId: string,
    candidates: string[],
    equals: (a: string, b: string) => boolean,
    opts: { db?: DB } = {},
  ): Promise<boolean> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .select({ id: mfaRecoveryCodes.id, codeHash: mfaRecoveryCodes.codeHash })
      .from(mfaRecoveryCodes)
      .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));
    let matchedId: string | null = null;
    for (const row of rows) {
      for (const candidate of candidates) {
        // Compare all rows/candidates (no break) to keep timing independent.
        if (equals(row.codeHash, candidate)) matchedId = row.id;
      }
    }
    if (!matchedId) return false;
    const consumed = await handle
      .update(mfaRecoveryCodes)
      .set({ usedAt: new Date() })
      .where(and(eq(mfaRecoveryCodes.id, matchedId), isNull(mfaRecoveryCodes.usedAt)))
      .returning({ id: mfaRecoveryCodes.id });
    return consumed.length > 0;
  }

  // ---- Login throttle (E4) ------------------------------------------------

  /** Read the throttle row for a (subject, ip) pair, if any. */
  async getLoginAttempt(
    subjectKey: string,
    ipHash: string,
    opts: { db?: DB } = {},
  ): Promise<{ failedCount: number; lockedUntil: Date | null } | null> {
    const handle = opts.db ?? this.db;
    const [row] = await handle
      .select({ failedCount: authLoginAttempts.failedCount, lockedUntil: authLoginAttempts.lockedUntil })
      .from(authLoginAttempts)
      .where(and(eq(authLoginAttempts.subjectKey, subjectKey), eq(authLoginAttempts.ipHash, ipHash)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Record one failed login and compute the lock window with exponential
   * backoff (capped) in a SINGLE statement (atomic; the unique index serializes
   * concurrent failures). Timestamps come from the DB clock.
   */
  async recordLoginFailure(
    subjectKey: string,
    ipHash: string,
    params: { threshold: number; windowSeconds: number; baseSeconds: number; maxSeconds: number },
    opts: { db?: DB } = {},
  ): Promise<{ failedCount: number; lockedUntil: Date | null }> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ failed_count: number; locked_until: Date | null }>(sql`
      INSERT INTO auth_login_attempts (subject_key, ip_hash, scope, failed_count, window_started_at, last_failed_at, locked_until)
      VALUES (${subjectKey}, ${ipHash}, 'account_ip', 1, now(), now(),
              CASE WHEN 1 >= ${params.threshold}
                   THEN now() + make_interval(secs => ${params.baseSeconds}) END)
      ON CONFLICT (subject_key, ip_hash) DO UPDATE SET
        failed_count = CASE
          WHEN auth_login_attempts.window_started_at > now() - make_interval(secs => ${params.windowSeconds})
            THEN auth_login_attempts.failed_count + 1
          ELSE 1 END,
        window_started_at = CASE
          WHEN auth_login_attempts.window_started_at > now() - make_interval(secs => ${params.windowSeconds})
            THEN auth_login_attempts.window_started_at
          ELSE now() END,
        last_failed_at = now(),
        locked_until = CASE
          WHEN (CASE WHEN auth_login_attempts.window_started_at > now() - make_interval(secs => ${params.windowSeconds})
                     THEN auth_login_attempts.failed_count + 1 ELSE 1 END) >= ${params.threshold}
          THEN now() + make_interval(secs => least(
                 ${params.baseSeconds} * power(2,
                   (CASE WHEN auth_login_attempts.window_started_at > now() - make_interval(secs => ${params.windowSeconds})
                         THEN auth_login_attempts.failed_count + 1 ELSE 1 END) - ${params.threshold}),
                 ${params.maxSeconds}))
          ELSE NULL END,
        updated_at = now()
      RETURNING failed_count, locked_until
    `);
    return {
      failedCount: res.rows[0]?.failed_count ?? 1,
      lockedUntil: res.rows[0]?.locked_until ?? null,
    };
  }

  /** Clear the throttle rows for a subject on successful authentication. */
  async resetLoginAttempts(subjectKey: string, opts: { db?: DB } = {}): Promise<void> {
    const handle = opts.db ?? this.db;
    await handle.delete(authLoginAttempts).where(eq(authLoginAttempts.subjectKey, subjectKey));
  }

  /**
   * Record an account-global failure (ip_hash = '', scope = 'account'). This
   * bucket NEVER locks: it only reports the count so the caller can add a
   * progressive soft delay (anti distributed brute force without letting an
   * attacker lock a victim's email).
   */
  async recordAccountFailure(
    subjectKey: string,
    windowSeconds: number,
    opts: { db?: DB } = {},
  ): Promise<number> {
    const handle = opts.db ?? this.db;
    const res = await handle.execute<{ failed_count: number }>(sql`
      INSERT INTO auth_login_attempts (subject_key, ip_hash, scope, failed_count, window_started_at, last_failed_at)
      VALUES (${subjectKey}, '', 'account', 1, now(), now())
      ON CONFLICT (subject_key, ip_hash) DO UPDATE SET
        failed_count = CASE
          WHEN auth_login_attempts.window_started_at > now() - make_interval(secs => ${windowSeconds})
            THEN auth_login_attempts.failed_count + 1
          ELSE 1 END,
        window_started_at = CASE
          WHEN auth_login_attempts.window_started_at > now() - make_interval(secs => ${windowSeconds})
            THEN auth_login_attempts.window_started_at
          ELSE now() END,
        last_failed_at = now(),
        updated_at = now()
      RETURNING failed_count
    `);
    return res.rows[0]?.failed_count ?? 1;
  }

  /** Sweep stale throttle rows (collector maintenance). */
  async sweepLoginAttempts(
    ttlSeconds: number,
    now: Date = new Date(),
    opts: { db?: DB } = {},
  ): Promise<number> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .delete(authLoginAttempts)
      .where(sql`${authLoginAttempts.lastFailedAt} < ${now}::timestamptz - make_interval(secs => ${ttlSeconds})`)
      .returning({ id: authLoginAttempts.id });
    return rows.length;
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
  async sweepChallenges(now: Date = new Date(), opts: { db?: DB } = {}): Promise<number> {
    const handle = opts.db ?? this.db;
    const rows = await handle
      .delete(authChallenges)
      .where(sql`${authChallenges.expiresAt} < ${now}`)
      .returning({ id: authChallenges.id });
    return rows.length;
  }
}
