/**
 * Pure domain helpers for llm-quota.
 *
 * Phase 0 scaffold. Window computation, FX and 12-month history retention are
 * added in Phase 1. These pure functions are unit-tested in isolation.
 */

import type { Quota } from "@llm-quota/shared";

/** Clamp a fraction into 0..1. */
export function clampFraction(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Given used and total, return the derived percentage used.
 * `used` and `total` must be finite; total <= 0 yields 0.
 */
export function percentUsed(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return clampFraction(used / total) * 100;
}

/** The percentage remaining on a quota, given used percent. */
export function percentRemaining(usedPercent: number): number {
  return clampFraction((100 - usedPercent) / 100) * 100;
}

/** Normalise a monetary usage value; negative input is clamped to 0. */
export function safeAmount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/**
 * Derive the "remaining" view of a quota record. For percent quotas this is
 * 100 - used; for credit quotas this is limit - used.
 */
export function deriveSummary(quota: Quota): {
  usedPercent: number;
  remainingPercent: number;
  usedAmount?: number;
  remainingAmount?: number;
} {
  if (quota.kind === "percent") {
    return {
      usedPercent: quota.usedPercent,
      remainingPercent: quota.remainingPercent,
    };
  }
  const remainingAmount = Math.max(0, quota.limit - quota.used);
  const usedPercent =
    quota.limit > 0 ? clampFraction(quota.used / quota.limit) * 100 : 0;
  return {
    usedPercent,
    remainingPercent: clampFraction((quota.limit - quota.used) / quota.limit) * 100,
    usedAmount: quota.used,
    remainingAmount,
  };
}
