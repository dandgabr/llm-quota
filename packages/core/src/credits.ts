/**
 * Monetary credits domain logic.
 *
 * Handles the two market shapes (account-level total vs used/limit quota) and
 * derives percentage + monetary summaries from a normalized credit record.
 */

import { clampFraction, safeAmount } from "./math.js";

export interface CreditTotals {
  /** Sum of credit amounts that count toward a spent figure. */
  used: number;
  /** Quota limit for the window, 0 when unlimited. */
  limit: number;
  /** Account-level total credits, 0 when absent. */
  total: number;
  currency: string;
}

/** Normalise partial credit input into a CreditTotals with clamped safe amounts. */
export function toCreditTotals(input: {
  used?: number;
  limit?: number;
  total?: number;
  currency: string;
}): CreditTotals {
  return {
    used: safeAmount(input.used ?? 0),
    limit: safeAmount(input.limit ?? 0),
    total: safeAmount(input.total ?? 0),
    currency: input.currency,
  };
}

export interface CreditSummary {
  /** Percentage of the limit used (0 when limit is absent/unlimited). */
  usedPercent: number;
  /** Percentage of the limit remaining. */
  remainingPercent: number;
  usedAmount: number;
  remainingAmount: number;
  limit: number;
  total: number;
}

/** Sum a list of credit totals into a single normalized total (same currency). */
export function sumCredits(totals: CreditTotals[]): CreditTotals {
  return totals.reduce<CreditTotals>(
    (acc, t) => ({
      used: safeAmount(acc.used + t.used),
      limit: safeAmount(acc.limit + t.limit),
      total: safeAmount(acc.total + t.total),
      currency: acc.currency || t.currency,
    }),
    { used: 0, limit: 0, total: 0, currency: totals[0]?.currency ?? "" },
  );
}

/** Derive a percentage + amount summary from normalized credit totals. */
export function summarizeCredits(totals: CreditTotals): CreditSummary {
  const remainingAmount = safeAmount(totals.limit - totals.used);
  const usedPercent =
    totals.limit > 0 ? clampFraction(totals.used / totals.limit) * 100 : 0;
  const remainingPercent =
    totals.limit > 0 ? clampFraction(remainingAmount / totals.limit) * 100 : 0;
  return {
    usedPercent,
    remainingPercent,
    usedAmount: totals.used,
    remainingAmount,
    limit: totals.limit,
    total: totals.total,
  };
}
