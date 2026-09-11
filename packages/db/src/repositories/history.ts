/**
 * History repository: implements the core `HistoryStore` contract on Postgres,
 * persisting only aggregates (daily/weekly/monthly) with the 12-month
 * retention boundary.
 *
 * Money is stored as numeric(18,6), which node-postgres returns as a string;
 * the repository converts to number on read and passes a normalized value on
 * write. On conflict the aggregate is INCREMENTED (never overwritten) so that
 * multiple records in the same slot accumulate correctly (ADR-004/ADR-005, C1).
 */

import { and, asc, eq, gte, lte, lt, sql } from "drizzle-orm";
import type { Aggregate, Granularity, HistoryStore } from "@llm-quota/core";
import type { DB } from "../client.js";
import { spendingAggregates } from "../schema/history.js";

const toNumber = (v: unknown): number => Number(v ?? 0);

export class PostgresHistoryStore implements HistoryStore {
  constructor(private readonly db: DB) {}

  async upsertAggregate(agg: Aggregate): Promise<void> {
    const amount = agg.spentAmount.toFixed(6); // normalize numeric as string
    await this.db
      .insert(spendingAggregates)
      .values({
        userId: agg.userId,
        connectionId: agg.connectionId,
        granularity: agg.granularity,
        window: agg.windowKey,
        spentAmount: amount,
        currency: agg.currency,
        count: agg.count,
      })
      .onConflictDoUpdate({
        target: [
          spendingAggregates.userId,
          spendingAggregates.connectionId,
          spendingAggregates.granularity,
          spendingAggregates.window,
        ],
        set: {
          spentAmount: sql`${spendingAggregates.spentAmount} + EXCLUDED.${spendingAggregates.spentAmount}`,
          count: sql`${spendingAggregates.count} + EXCLUDED.${spendingAggregates.count}`,
          updatedAt: new Date(),
        },
      });
  }

  async listByUser(
    userId: string,
    granularity: Granularity,
    from: string,
    to: string,
  ): Promise<Aggregate[]> {
    const rows = await this.db
      .select()
      .from(spendingAggregates)
      .where(
        and(
          eq(spendingAggregates.userId, userId),
          eq(spendingAggregates.granularity, granularity),
          gte(spendingAggregates.window, from),
          lte(spendingAggregates.window, to),
        ),
      )
      .orderBy(asc(spendingAggregates.window));

    return rows.map((r) => ({
      granularity: r.granularity as Granularity,
      windowKey: r.window,
      userId: r.userId,
      connectionId: r.connectionId,
      spentAmount: toNumber(r.spentAmount),
      currency: r.currency,
      count: r.count,
    }));
  }

  async evictOlderThan(before: string): Promise<number> {
    const result = await this.db
      .delete(spendingAggregates)
      .where(lt(spendingAggregates.window, before))
      .returning({ id: spendingAggregates.id });
    return result.length;
  }

  /** Delete raw snapshots older than a retention boundary (Phase 3 collector). */
  async evictSnapshotsOlderThan(before: string): Promise<number> {
    const { quotaSnapshots } = await import("../schema/quotas.js");
    const result = await this.db
      .delete(quotaSnapshots)
      .where(lt(quotaSnapshots.readAt, new Date(before)))
      .returning({ id: quotaSnapshots.id });
    return result.length;
  }
}
