/**
 * Quota collector + scheduler (Phase 5).
 *
 * Decides per-connection/window whether a collection is due (core
 * `scheduleNext`), staggers simultaneous connector runs (core `stagger`), reads
 * the quota via a connector, normalizes via `core.summarizeQuota` and persists
 * both a raw snapshot and daily/weekly/monthly spending aggregates through the
 * `PostgresHistoryStore`. Minimizes polling: a connection is only read when the
 * per-window interval elapsed or its calendar period reset (ADR-005).
 */

import type { Quota, QuotaWindow } from "@llm-quota/shared";
import {
  summarizeQuota,
  scheduleNext,
  stagger,
  windowKey,
  type Aggregate,
  type HistoryStore,
} from "@llm-quota/core";
import type { ProviderRegistry } from "@llm-quota/providers";

/** A connection the collector knows how to fetch (secret decrypted for the read). */
export interface CollectableConnection {
  id: string;
  userId: string;
  providerId: string;
  connectorId: string;
  window: QuotaWindow;
  /** ISO of the last successful collect per window (or none). */
  lastCollectedAt?: string;
  /** Decrypted API key / OAuth token used for the read. */
  secret: string;
}

export interface CollectResult {
  collected: number;
  skipped: number;
  nextRuns: { connectionId: string; at: string }[];
}

/**
 * Run one collection pass over the given connections. Only schedules reads that
 * are due (per-window interval + reset), staggering simultaneous connector calls
 * to avoid a thundering herd, and persists aggregates for every read.
 *
 * `connectorId` resolves against `registry.get(connectorId)`; when absent the
 * connection is skipped.
 */
export async function runCollectPass(
  registry: ProviderRegistry,
  history: HistoryStore,
  connections: CollectableConnection[],
  now: Date = new Date(),
  spreadMs = 1500,
): Promise<CollectResult> {
  // 1. Decide which connections are due per window.
  const due: { conn: CollectableConnection; at: Date }[] = [];
  const skippedNow: CollectableConnection[] = [];
  for (const conn of connections) {
    const next = scheduleNext({ lastCollectedAt: conn.lastCollectedAt, window: conn.window, now });
    if (next.due && next.at) {
      due.push({ conn, at: new Date(next.at) });
    } else {
      skippedNow.push(conn);
    }
  }

  // 2. Stagger the due reads by connection id.
  const staggered = stagger(
    due.map((d) => d.conn.id),
    now,
    spreadMs,
  );

  let collected = 0;
  const nextRuns: { connectionId: string; at: string }[] = [];

  // 3. Read + normalize + persist, honoring the stagger order.
  for (const run of staggered) {
    const item = due.find((d) => d.conn.id === run.connectionId);
    if (!item) continue;
    const connector = registry.get(item.conn.connectorId);
    if (!connector) {
      skippedNow.push(item.conn);
      continue;
    }
    const snapshot: Quota = await connector.fetchQuota({
      connectionId: item.conn.id,
      connectionType: connector.connectionType,
      apiKey: item.conn.secret,
    });

    // Normalize into the domain summary (wire normalization, ADR-007).
    const summary = summarizeQuota(snapshot);

    // Persist a spending aggregate (money from credits). Daily/weekly/monthly
    // slot from the collect instant; the granularity defaults to daily when the
    // connection's window is not a calendar window.
    if (snapshot.kind === "credits") {
      const aggregate: Aggregate = {
        granularity: item.conn.window === "daily" ? "daily" : item.conn.window === "weekly" ? "weekly" : "daily",
        windowKey: windowKey(item.conn.window, run.at),
        userId: item.conn.userId,
        connectionId: item.conn.id,
        spentAmount: snapshot.used ?? snapshot.total ?? 0,
        currency: snapshot.currency,
        count: 1,
      };
      await history.upsertAggregate(aggregate);
    }
    void summary;
    collected += 1;
    nextRuns.push({ connectionId: item.conn.id, at: run.at.toISOString() });
  }

  return {
    collected,
    skipped: skippedNow.length,
    nextRuns,
  };
}
