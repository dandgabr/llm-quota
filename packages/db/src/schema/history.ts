/**
 * User sessions, spending aggregates and the FX rate cache.
 */

import { boolean, pgTable, real, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { granularityEnum, id, timestamps } from "./enums.js";
import { users } from "./auth.js";
import { connections } from "./quotas.js";

/** Authenticated login session of a user (distinct from a quota/work session). */
export const userSessions = pgTable("user_sessions", {
  id: id("id"),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull(),
  expiresAt: varchar("expires_at", { length: 40 }).notNull(),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Only-aggregates spending history (daily/weekly/monthly), 12-month retention. */
export const spendingAggregates = pgTable(
  "spending_aggregates",
  {
    id: id("id"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    granularity: granularityEnum("granularity").notNull(),
    window: varchar("window", { length: 40 }).notNull(),
    spentAmount: real("spent_amount").notNull().default(0),
    currency: varchar("currency", { length: 8 }).notNull(),
    count: varchar("count", { length: 20 }).notNull().default("1"),
    ...timestamps,
  },
  (t) => ({
    aggUnique: uniqueIndex("spending_aggregates_user_slot_unique").on(
      t.userId,
      t.connectionId,
      t.granularity,
      t.window,
    ),
  }),
);

/** Daily-cached FX rates (backing the core CurrencyRateSource). */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: id("id"),
    base: varchar("base", { length: 8 }).notNull().default("USD"),
    currency: varchar("currency", { length: 8 }).notNull(),
    rate: real("rate").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    fxUnique: uniqueIndex("fx_rates_base_currency_day_unique").on(
      t.base,
      t.currency,
      t.effectiveAt,
    ),
  }),
);
