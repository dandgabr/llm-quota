/**
 * Currency (FX) conversion domain.
 *
 * Pure policy + an injected rate source. The daily-cached rate store is an
 * interface; the Postgres-backed implementation lands in Phase 2. Formatting is
 * delegated to `Intl.NumberFormat` in consumers, never hardcoded in strings.
 */

import { safeAmount } from "./math.js";

/** Normalized currency code (ISO 4217 uppercase). */
export type CurrencyCode = string;

/** Conversion rate source. Persistence of the daily cache is a repository concern. */
export interface CurrencyRateSource {
  /** Latest rate to convert 1 USD into `to`. May hit a daily cache. */
  rateUsdTo(to: CurrencyCode): Promise<number | null>;
}

export interface ConvertInput {
  amount: number;
  from: CurrencyCode;
  to: CurrencyCode;
}

export interface ConvertResult {
  amount: number;
  from: CurrencyCode;
  to: CurrencyCode;
  /** Effective rate used (1 of `from` -> `to`); 1 when source==target. */
  rate: number;
}

/**
 * Convert an amount. When `from === to`, returns the amount unchanged with
 * rate 1 without contacting the source. Otherwise divides by the USD->from
 * rate to normalize, then multiplies by the USD->to rate.
 *
 * Returns null when the source has no rate for `to` (missing/unsupported).
 */
export async function convertCurrency(
  input: ConvertInput,
  source: CurrencyRateSource,
): Promise<ConvertResult | null> {
  const amount = safeAmount(input.amount);
  if (fromCodeToUpper(input.from) === fromCodeToUpper(input.to)) {
    return { amount, from: input.from, to: input.to, rate: 1 };
  }
  const rateUsdTo = await source.rateUsdTo(input.to);
  const rateSourceIsUsd = fromCodeToUpper(input.from) === "USD";
  const rateFromUsd = rateSourceIsUsd ? 1 : await source.rateUsdTo(input.from);
  if (rateUsdTo == null || rateFromUsd == null || rateFromUsd <= 0) return null;
  // normalizingFactor: 1 from -> USD; then USD -> to.
  const normalized = rateSourceIsUsd ? amount : amount / rateFromUsd;
  const converted = normalized * rateUsdTo;
  const rate = rateSourceIsUsd ? rateUsdTo : rateUsdTo / rateFromUsd;
  return { amount: converted, from: input.from, to: input.to, rate };
}

function fromCodeToUpper(code: string): string {
  return code.toUpperCase();
}
