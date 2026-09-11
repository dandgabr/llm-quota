/**
 * History repository: implements the core `HistoryStore` contract on Postgres,
 * persisting only aggregates (daily/weekly/monthly) with the 12-month
 * retention boundary.
 */

import { and, asc, eq, lt } from "drizzle-orm";
import type { Aggregate, Granularity, HistoryStore } from "@llm-quota/core";
import type { DB } from "../client.js";
import { spendingAggregates } from "../schema/history.js";

export class PostgresHistoryStore implements HistoryStore {
  constructor(private readonly db: DB) {}

  async upsertAggregate(agg: Aggregate): Promise<void> {
    await this.db
      .insert(spendingAggregates)
      .values({
        userId: agg.userId,
        connectionId: agg.connectionId,
        granularity: agg.granularity,
        window: agg.windowKey,
        spentAmount: agg.spentAmount,
        currency: agg.currency,
        count: String(agg.count),
      })
      .onConflictDoUpdate({
        target: [
          spendingAggregates.userId,
          spendingAggregates.connectionId,
          spendingAggregates.granularity,
          spendingAggregates.window,
        ],
        set: {
          spentAmount: agg.spentAmount,
          count: String(agg.count),
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
          // windowKey is an ISO slot; filter by lexicographic range
        ),
      )
      .orderBy(asc(spendingAggregates.window));

    return rows
      .filter((r) => r.window >= from && r.window <= to)
      .map((r) => ({
        granularity: r.granularity as Granularity,
        windowKey: r.window,
        userId: r.userId,
        connectionId: r.connectionId,
        spentAmount: r.spentAmount,
        currency: r.currency,
        count: Number(r.count),
      }));
  }

  async evictOlderThan(before: string): Promise<number> {
    const result = await this.db
      .delete(spendingAggregates)
      .where(lt(spendingAggregates.window, before))
      .returning({ id: spendingAggregates.id });
    return result.length;
  }
}
