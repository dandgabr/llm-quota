/**
 * Percentage-based quota domain logic and summary derivation.
 */

import type { Quota } from "@llm-quota/shared";
import { pct, safeRatio } from "./math.js";
import { summarizeCredits, toCreditTotals } from "./credits.js";

/** Percentage used given used/total in consistent units. */
export function percentUsed(used: number, total: number): number {
  return pct(safeRatio(used, total));
}

/** Percentage remaining given used/total. */
export function percentRemaining(used: number, total: number): number {
  return pct(1 - safeRatio(used, total));
}

export interface QuotaSummary {
  kind: Quota["kind"];
  /** Percentage of the quota used (0..100). */
  usedPercent: number;
  /** Percentage of the quota remaining (0..100). */
  remainingPercent: number;
  /** Monetary amount used (credit quotas only). */
  usedAmount?: number;
  /** Monetary amount remaining (credit quotas only). */
  remainingAmount?: number;
}

/**
 * Derive a normalized summary from any provider quota record, bridging the two
 * credit shapes (account total vs used/limit) into a single view.
 */
export function summarizeQuota(quota: Quota): QuotaSummary {
  if (quota.kind === "percent") {
    return {
      kind: "percent",
      usedPercent: quota.usedPercent,
      remainingPercent: quota.remainingPercent,
    };
  }
  const totals = toCreditTotals(quota);
  const sum = summarizeCredits(totals);
  return {
    kind: "credits",
    usedPercent: sum.usedPercent,
    remainingPercent: sum.remainingPercent,
    usedAmount: sum.usedAmount,
    remainingAmount: sum.remainingAmount,
  };
}
