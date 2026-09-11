/**
 * Shared domain types for llm-quota.
 *
 * Core vocabulary agreed across packages. TypeScript monorepo, English.
 */

/** Distinct periods a quota can be measured against. */
export type QuotaWindow = "session" | "daily" | "weekly" | "monthly" | "lifetime";

/** How a quota is expressed: a relative percentage or monetary credits. */
export type QuotaKind = "percent" | "credits";

export interface UsagePercent {
  kind: "percent";
  usedPercent: number;
  remainingPercent: number;
  /** When the quota window resets (ISO instant). */
  resetsAt?: string;
}

/**
 * Monetary credits. Captures both market shapes:
 * - 2.1 account-level credits: only `total` present (X dollars in the account).
 * - 2.2 capped quota: `used` + `limit` present (X used of Y quota).
 */
export interface UsageCredits {
  kind: "credits";
  currency: string;
  /** Total credits in the account (shape 2.1). */
  total?: number;
  /** Amount used against a quota (shape 2.2). */
  used?: number;
  /** Quota limit against which `used` counts (shape 2.2). */
  limit?: number;
  resetsAt?: string;
}

/** A normalized provider quota record: either percentage or monetary credits. */
export type Quota = UsagePercent | UsageCredits;

/** A connection type for a provider (e.g. OAuth vs API). */
export type ConnectionType = "oauth" | "api";

/** Unique key for a registered connector, e.g. `openai/codex` or `openrouter/api`. */
export type ProviderKey = string;

/** A user-saved connection to a provider, carrying an optional label. */
export interface Connection {
  id: string;
  userId: string;
  providerKey: ProviderKey;
  label: string;
  connectionType: ConnectionType;
  /** ISO created timestamp. */
  createdAt: string;
}
/** Roles for the RBAC model (requirement 9). */
export type Role = "user" | "supervisor" | "admin";
