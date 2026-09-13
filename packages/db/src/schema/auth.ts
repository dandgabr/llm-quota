/**
 * Users, profiles/RBAC and OIDC identity providers.
 */

import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { id, roleEnum, timestamps } from "./enums.js";

/**
 * A local application account. Credentials live in `user_credentials` (not a
 * column here) so a plain `select()` never reads a password hash; soft delete
 * uses `deleted_at` and the unique email index is partial on live rows only.
 */
export const users = pgTable(
  "users",
  {
    id: id("id"),
    email: varchar("email", { length: 320 }).notNull(),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    firstName: varchar("first_name", { length: 120 }),
    lastName: varchar("last_name", { length: 120 }),
    role: roleEnum("role").notNull().default("user"),
    locale: varchar("locale", { length: 20 }).notNull().default("en"),
    isActive: boolean("is_active").notNull().default(true),
    /** Soft delete: non-null means the account is removed from active service. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** LGPD anonymization: non-null means PII was scrubbed (id kept for audit). */
    anonymizedAt: timestamp("anonymized_at", { withTimezone: true }),
    /** External IdP subject (OIDC `sub` / SCIM externalId); reserved. */
    externalId: varchar("external_id", { length: 255 }),
    ...timestamps,
  },
  (t) => ({
    // Partial functional unique: one live account per lowercased email; a
    // soft-deleted row frees the email for re-registration.
    emailLowerUnique: uniqueIndex("users_email_lower_unique")
      .on(sql`lower(${t.email})`)
      .where(sql`${t.deletedAt} IS NULL`),
    externalIdUnique: uniqueIndex("users_external_id_unique")
      .on(t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
  }),
);

/** Password credential for a local account (separate table, never wire-exposed). */
export const userCredentials = pgTable("user_credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** PHC-style scrypt string; NULL for invited / SSO-only accounts. */
  passwordHash: text("password_hash"),
  passwordUpdatedAt: timestamp("password_updated_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A one-time, expiring invitation to create (or reset) an account. */
export const userInvites = pgTable(
  "user_invites",
  {
    id: id("id"),
    email: varchar("email", { length: 320 }).notNull(),
    role: roleEnum("role").notNull().default("user"),
    /** Hash of the invite token (the raw token is never stored). */
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    /** When set, accepting UPDATES this user's credential (password reset). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex("user_invites_token_hash_unique").on(t.tokenHash),
  }),
);

/**
 * Idempotency ledger for non-idempotent API mutations. Keyed per user; stores
 * the response snapshot so a retry replays instead of re-executing.
 */
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    key: varchar("key", { length: 255 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: uniqueIndex("idempotency_keys_user_key_unique").on(t.userId, t.key),
    expiresIdx: index("idempotency_keys_expires_idx").on(t.expiresAt),
  }),
);

/**
 * Singleton instance state, read OUTSIDE RLS by SECURITY DEFINER functions that
 * authorize first-run setup. Holds only the bootstrap token *hash*.
 */
export const instanceSettings = pgTable("instance_settings", {
  id: varchar("id", { length: 32 }).primaryKey().default("singleton"),
  setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
  bootstrapTokenHash: varchar("bootstrap_token_hash", { length: 128 }),
  bootstrapTokenExpiresAt: timestamp("bootstrap_token_expires_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Dynamic instance configuration (collector refresh interval, notices, etc.). */
export const systemSettings = pgTable("system_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** FIDO2 / WebAuthn credential (passkey / security key). */
export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: id("id"),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialId: varchar("credential_id").notNull(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: jsonb("transports").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** TOTP secret for authenticator-app MFA (stored encrypted, never plaintext). */
export const totpSecrets = pgTable("totp_secrets", {
  id: id("id"),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  secretCipher: text("secret_cipher").notNull(),
  algorithm: varchar("algorithm", { length: 20 }).notNull().default("SHA1"),
  /** Last consumed TOTP step (anti-replay). */
  lastUsedStep: integer("last_used_step"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Single-use MFA recovery codes (hashed; shown once at enrollment). */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    id: id("id"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: varchar("code_hash", { length: 128 }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: uniqueIndex("mfa_recovery_codes_code_unique").on(t.userId, t.codeHash),
  }),
);

/**
 * Short-lived, single-use login MFA challenge. NOT a session: it cannot be
 * resolved by the auth middleware, only consumed once by the MFA step.
 */
export const authChallenges = pgTable(
  "auth_challenges",
  {
    id: id("id"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    method: varchar("method", { length: 20 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    challengeUserIdx: index("auth_challenges_user_idx").on(t.userId, t.expiresAt),
  }),
);

/**
 * Durable login throttle state (E4). Keyed by an HMAC of the normalized email
 * (never stored in clear) and an optional IP hash, so a distributed brute force
 * is bounded without enabling account-DoS by email alone.
 */
export const authLoginAttempts = pgTable(
  "auth_login_attempts",
  {
    id: id("id"),
    /** HMAC(AUTH_PEPPER, lower(email)); never the plain email. */
    subjectKey: varchar("subject_key", { length: 64 }).notNull(),
    /** HMAC(AUTH_PEPPER, canonical ip); '' = account-global bucket. */
    ipHash: varchar("ip_hash", { length: 64 }).notNull().default(""),
    scope: varchar("scope", { length: 16 }).notNull().default("account_ip"),
    failedCount: integer("failed_count").notNull().default(0),
    windowStartedAt: timestamp("window_started_at", { withTimezone: true }),
    lastFailedAt: timestamp("last_failed_at", { withTimezone: true }).notNull().defaultNow(),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    keyUnique: uniqueIndex("auth_login_attempts_key_unique").on(t.subjectKey, t.ipHash),
    sweepIdx: index("auth_login_attempts_sweep_idx").on(t.lastFailedAt),
  }),
);

/** Registered OIDC identity providers (Google/GitHub/Discord/SSO future). */
export const identityProviders = pgTable("identity_providers", {
  id: id("id"),
  name: varchar("name", { length: 120 }).notNull(),
  issuer: varchar("issuer", { length: 255 }).notNull(),
  clientId: varchar("client_id", { length: 255 }).notNull(),
  clientSecretCipher: text("client_secret_cipher").notNull(),
  discoveryUrl: varchar("discovery_url", { length: 255 }),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps,
});
