/**
 * Users, profiles/RBAC and OIDC identity providers.
 */

import { boolean, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { id, roleEnum, timestamps } from "./enums.js";

/** A local application account. */
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
    ...timestamps,
  },
  (t) => ({
    emailUnique: uniqueIndex("users_email_unique").on(t.email),
  }),
);

/** FIDO2 / WebAuthn credential (passkey / security key). */
export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: id("id"),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialId: varchar("credential_id").notNull(),
  publicKey: text("public_key").notNull(),
  counter: varchar("counter").notNull().default("0"),
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
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
