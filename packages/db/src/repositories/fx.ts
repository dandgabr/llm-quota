/**
 * FX repository: implements the core `CurrencyRateSource` contract backed by
 * the daily-cached `fx_rates` table.
 */

import { and, eq, gte, lte } from "drizzle-orm";
import type { CurrencyRateSource } from "@llm-quota/core";
import type { DB } from "../client.js";
import { fxRates } from "../schema/history.js";

const DAY_MS = 86_400_000;

/**
 * Postgres-backed CurrencyRateSource, reading the daily-cached `fx_rates`.
 */
export class PostgresFxRateSource implements CurrencyRateSource {
  constructor(private readonly db: DB) {}

  /** Latest cached USD->`to` rate for today, or null when unavailable. */
  async rateUsdTo(to: string): Promise<number | null> {
    const dayStart = startOfDay(new Date());
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const row = await this.db
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.base, "USD"),
          eq(fxRates.currency, to.toUpperCase()),
          gte(fxRates.effectiveAt, dayStart),
          lte(fxRates.effectiveAt, dayEnd),
        ),
      )
      .limit(1);
    const rate = row[0]?.rate;
    return rate == null ? null : Number(rate);
  }

  /** Upsert a fetched rate for today (daily cache policy). */
  async cacheRate(currency: string, rate: number, now: Date = new Date()): Promise<void> {
    await this.db
      .insert(fxRates)
      .values({
        base: "USD",
        currency: currency.toUpperCase(),
        rate: rate.toFixed(8),
        effectiveAt: startOfDay(now),
      })
      .onConflictDoUpdate({
        target: [fxRates.base, fxRates.currency, fxRates.effectiveAt],
        set: { rate: rate.toFixed(8) },
      });
  }
}

function startOfDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
