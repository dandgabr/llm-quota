/**
 * Spending-history domain: 12-month retention and session-cycle aggregation.
 *
 * Implements the agreed model: retain ONLY aggregates (daily -> weekly ->
 * monthly), no raw detail, hard-capped at the last 12 months. "Session cycle"
 * is a bounded run over incoming snapshots committed at a cycle boundary. The
 * persistence/repository boundary is an interface; the Postgres implementation
 * lands in Phase 2.
 */

import type { QuotaWindow } from "@llm-quota/shared";
import { windowKey } from "./windows.js";
import { sumCredits, toCreditTotals, type CreditTotals } from "./credits.js";
import { safeAmount } from "./math.js";

export const HISTORY_RETENTION_MONTHS = 12;

/** A single normalized spending entry produced by a quota read. */
export interface SpendingRecord {
  userId: string;
  connectionId: string;
  window: QuotaWindow;
  /** Amount spent attributable to this record, in record currency. */
  spentAmount: number;
  /** Record currency code. */
  currency: string;
  /** ISO instant this record belongs to. */
  at: string;
}

/**
 * Aggregate slot keyed by user + window slot + granularity. Mirrors the
 * "aggregates only" model: `granularity` is daily / weekly / monthly.
 */
export type Granularity = "daily" | "weekly" | "monthly";

export interface Aggregate {
  granularity: Granularity;
  windowKey: string;
  userId: string;
  connectionId: string;
  spentAmount: number;
  currency: string;
  count: number;
}

/** Persistence boundary for aggregates; Postgres impl in Phase 2. */
export interface HistoryStore {
  upsertAggregate(agg: Aggregate): Promise<void>;
  /** List aggregates within a retention window for a user. */
  listByUser(
    userId: string,
    granularity: Granularity,
    from: string,
    to: string,
  ): Promise<Aggregate[]>;
  /** Delete aggregates older than the retention boundary (eviction). */
  evictOlderThan(before: string): Promise<number>;
}

/** A bounded run over incoming records; commit it at a session-cycle boundary. */
export interface SessionBatch {
  userId: string;
  connectionId: string;
  records: SpendingRecord[];
}

const DAY_MS = 86_400_000;

function startOfGranularity(at: Date, g: Granularity): Date {
  switch (g) {
    case "daily":
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
    case "weekly":
      return new Date(
        Date.UTC(
          at.getUTCFullYear(),
          at.getUTCMonth(),
          at.getUTCDate() - ((at.getUTCDay() + 6) % 7),
        ),
      );
    case "monthly":
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  }
}

function granularitySlot(g: Granularity, at: Date): string {
  return startOfGranularity(at, g).toISOString();
}

function isRetained(_window: QuotaWindow): boolean {
  // Lifetime windows are always retained (they never expire); calendar windows
  // participate in the 12-month cap.
  return true;
}

/**
 * Roll a `SessionBatch` into daily/weekly/monthly aggregates for each record,
 * applying the 12-month retention filter per record. Returns the aggregates to
 * persist via `HistoryStore`.
 */
export function rollupSessionBatch(batch: SessionBatch, now: Date): Aggregate[] {
  const out: Aggregate[] = [];
  for (const record of batch.records) {
    const retentionBoundary = new Date(
      now.getTime() - HISTORY_RETENTION_MONTHS * 30 * DAY_MS,
    );
    if (new Date(record.at) < retentionBoundary) continue; // outside 12-month window
    if (!isRetained(record.window)) continue;

    const granularities: Granularity[] = ["daily", "weekly", "monthly"];
    for (const g of granularities) {
      out.push({
        granularity: g,
        windowKey: `${g}:${granularitySlot(g, new Date(record.at))}`,
        userId: batch.userId,
        connectionId: batch.connectionId,
        spentAmount: record.spentAmount,
        currency: record.currency,
        count: 1,
      });
    }
  }
  return out;
}

/** Merge two aggregates of the same slot into one (used by upsert merge). */
export function mergeAggregates(a: Aggregate, b: Aggregate): Aggregate {
  return {
    ...a,
    spentAmount: safeAmount(a.spentAmount + b.spentAmount),
    count: a.count + b.count,
  };
}

/**
 * Build the 12-month retention boundary (ISO) for eviction queries.
 */
export function retentionBoundary(now: Date): string {
  return new Date(now.getTime() - HISTORY_RETENTION_MONTHS * 30 * DAY_MS).toISOString();
}

export { sumCredits, toCreditTotals, windowKey };
export type { CreditTotals };
