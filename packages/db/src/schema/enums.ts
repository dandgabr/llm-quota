/**
 * Shared enums / reusable column helpers for the llm-quota schema.
 */

import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

/** RBAC roles (requirement 9). */
export const roleEnum = pgEnum("role", ["user", "supervisor", "admin"]);

export const roleEnumValues = roleEnum.enumValues;

export type Role = (typeof roleEnumValues)[number];

/** A connection type for a provider (OAuth vs API). */
export const connectionTypeEnum = pgEnum("connection_type", ["oauth", "api"]);

/** Quota window granularity. */
export const quotaWindowEnum = pgEnum("quota_window", [
  "session",
  "daily",
  "weekly",
  "monthly",
  "lifetime",
]);

/** Aggregate granularity for spending history. */
export const granularityEnum = pgEnum("granularity", ["daily", "weekly", "monthly"]);

/** Quota expression kind: relative percentage or monetary credits. */
export const quotaKindEnum = pgEnum("quota_kind", ["percent", "credits"]);

export const id = (name: string) => uuid(name).notNull().primaryKey().defaultRandom();

export const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};
