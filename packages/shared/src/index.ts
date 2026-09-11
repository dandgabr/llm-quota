/**
 * Shared domain types for llm-quota.
 *
 * Phase 0 scaffold — the core vocabulary is defined here so other packages and
 * the API can agree on shapes. Expanded as the domain solidifies in Phase 1.
 */

/** Distinct periods a quota can be measured against. */
export type QuotaWindow =
  | "session"
  | "daily"
  | "weekly"
  | "monthly"
  | "lifetime";

/** How a quota is expressed: a relative percentage or monetary credits. */
export type QuotaKind = "percent" | "credits";

export interface UsagePercent {
  kind: "percent";
  usedPercent: number;
  remainingPercent: number;
  /** When the quota window resets (ISO instant). */
  resetsAt?: string;
}

export interface UsageCredits {
  kind: "credits";
  used: number;
  limit: number;
  total: number;
  currency: string;
  resetsAt?: string;
}

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
