/** Pure numeric helpers. No domain logic; values in fractional/percentage terms. */

/** Clamp a fraction (0..1); NaN maps to 0. */
export const clampFraction = (value: number): number => {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
};

/** Convert a 0..1 fraction to a clamped percentage (0..100). */
export const pct = (value: number): number => clampFraction(value) * 100;

/** Normalises a monetary amount; negatives and NaN clamp to 0. */
export const safeAmount = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

/** Safe ratio used/total; returns 0 for non-finite or non-positive totals. */
export const safeRatio = (used: number, total: number): number => {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return used / total;
};
