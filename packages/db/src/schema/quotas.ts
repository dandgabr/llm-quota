/**
 * Quota providers, connections (multi-label / multi-type) and quota data.
 */

import {
  boolean,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { connectionTypeEnum, id, quotaKindEnum, quotaWindowEnum, timestamps } from "./enums.js";
import { users } from "./auth.js";

/** Registered quota providers (Ollama Claude, OpenRouter, …). */
export const quotaProviders = pgTable(
  "quota_providers",
  {
    id: id("id"),
    providerKey: varchar("provider_key", { length: 120 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    /** Connector module id, e.g. `ollama-claude/api`. */
    connectorId: varchar("connector_id", { length: 160 }).notNull(),
    connectionType: connectionTypeEnum("connection_type").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    ...timestamps,
  },
  (t) => ({
    providerUnique: uniqueIndex("quota_providers_provider_key_type_unique").on(
      t.providerKey,
      t.connectionType,
    ),
  }),
);

/** A user's saved connection to a provider, carrying a label (multi per provider). */
export const connections = pgTable(
  "connections",
  {
    id: id("id"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => quotaProviders.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 200 }).notNull(),
    connectionType: connectionTypeEnum("connection_type").notNull(),
    /** Encrypted API key / OAuth refresh token (envelope-encrypted). */
    secretCipher: text("secret_cipher").notNull(),
    ...timestamps,
  },
  (t) => ({
    userProviderUnique: uniqueIndex("connections_user_provider_unique").on(
      t.userId,
      t.providerId,
      t.label,
    ),
  }),
);

/**
 * A quota/work session as returned by a provider: % remaining and time-to-reset.
 * Distinct from the user's authenticated session (see sessions.ts).
 */
export const quotaSessions = pgTable("quota_sessions", {
  id: id("id"),
  connectionId: uuid("connection_id")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  window: quotaWindowEnum("window").notNull(),
  usedPercent: numeric("used_percent", { precision: 6, scale: 3 }),
  remainingPercent: numeric("remaining_percent", { precision: 6, scale: 3 }),
  /** Provider-defined resets-at instant. */
  resetsAt: timestamp("resets_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A recorded quota snapshot (raw read) for a connection + window. */
export const quotaSnapshots = pgTable(
  "quota_snapshots",
  {
    id: id("id"),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    quotaSessionId: uuid("quota_session_id").references(() => quotaSessions.id, {
      onDelete: "set null",
    }),
    kind: quotaKindEnum("kind").notNull().default("percent"),
    window: quotaWindowEnum("window").notNull(),
    currency: varchar("currency", { length: 8 }),
    /** Monetary credits JSON (used/limit/total/resets_at). */
    credits: jsonb("credits").$type<{
      used?: number;
      limit?: number;
      total?: number;
    }>(),
    /** Percent usage (kind=percent). */
    usedPercent: numeric("used_percent", { precision: 6, scale: 3 }),
    remainingPercent: numeric("remaining_percent", { precision: 6, scale: 3 }),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    /** ISO of the read. */
    readAt: timestamp("read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    connectionWindowRead: uniqueIndex("quota_snapshots_conn_window_read_unique").on(
      t.connectionId,
      t.window,
      t.readAt,
    ),
    snapshotReadIndex: index("quota_snapshots_conn_read_idx").on(t.connectionId, t.readAt),
  }),
);
