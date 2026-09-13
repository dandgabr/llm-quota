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
import type { PostgresQuotaStore } from "@llm-quota/db";
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
  /** Connections whose fetch/persist failed (error isolated per connection). */
  failed: number;
  nextRuns: { connectionId: string; at: string }[];
}

/** Persistence boundary for raw snapshots (optional collector output). */
export interface SnapshotSink {
  insertSnapshot(
    input: Parameters<PostgresQuotaStore["insertSnapshot"]>[0],
  ): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run one collection pass over the given connections. Only schedules reads that
 * are due (per-window interval + reset), staggering simultaneous connector calls
 * to avoid a thundering herd, and persists aggregates for every read. A single
 * connection failure is contained (counted in `failed`) and never aborts the
 * pass.
 *
 * `connectorId` resolves against `registry.get(connectorId)`; when absent the
 * connection is skipped. When `snapshots` is provided the raw read is also
 * persisted (7-day diagnostics retention, ADR-005).
 */
export async function runCollectPass(
  registry: ProviderRegistry,
  history: HistoryStore,
  connections: CollectableConnection[],
  now: Date = new Date(),
  spreadMs = 1500,
  snapshots?: SnapshotSink,
  logger?: (msg: string) => void,
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
  let failed = 0;
  const nextRuns: { connectionId: string; at: string }[] = [];

  // 3. Read + normalize + persist, honoring the stagger order (await the slot).
  for (const run of staggered) {
    const item = due.find((d) => d.conn.id === run.connectionId);
    if (!item) continue;
    const waitMs = run.at.getTime() - Date.now();
    if (waitMs > 0) await sleep(Math.min(waitMs, spreadMs * due.length));
    const connector = registry.get(item.conn.connectorId);
    if (!connector) {
      skippedNow.push(item.conn);
      continue;
    }
    try {
      const snapshot: Quota = await connector.fetchQuota({
        connectionId: item.conn.id,
        connectionType: connector.connectionType,
        apiKey: item.conn.secret,
        window: item.conn.window,
      } as Parameters<typeof connector.fetchQuota>[0]);

      // Normalize into the domain summary (wire normalization, ADR-007).
      const summary = summarizeQuota(snapshot);

      // Persist the raw snapshot (diagnostics; evicted by the scheduler TTL).
      if (snapshots) {
        const credits =
          snapshot.kind === "credits"
            ? { used: snapshot.used, limit: snapshot.limit, total: snapshot.total }
            : snapshot.modelGroups
              ? { modelGroups: snapshot.modelGroups }
              : undefined;
        const resetIso = snapshot.resetsAt;
        await snapshots.insertSnapshot({
          connectionId: item.conn.id,
          kind: snapshot.kind,
          window: item.conn.window,
          currency: snapshot.kind === "credits" ? snapshot.currency : undefined,
          credits,
          usedPercent: summary.usedPercent,
          remainingPercent: summary.remainingPercent,
          resetsAt: resetIso ? new Date(resetIso) : undefined,
          readAt: run.at,
        });
      }

      // Persist a SPENDING aggregate only for real usage deltas: `used` is
      // spend since window start; a credits-balance read (`total` only) is a
      // point-in-time stock, never a flow — adding it per poll would inflate
      // the aggregates linearly. Slots map a connection's window to a
      // granularity: daily/weekly/monthly for those calendar windows;
      // session/lifetime fall back to daily (the finest persisted granularity).
      if (snapshot.kind === "credits" && typeof snapshot.used === "number") {
        const granularity =
          item.conn.window === "daily"
            ? "daily"
            : item.conn.window === "weekly"
              ? "weekly"
              : item.conn.window === "monthly"
                ? "monthly"
                : "daily";
        const aggregate: Aggregate = {
          granularity,
          windowKey: windowKey(item.conn.window === "session" || item.conn.window === "lifetime" ? "daily" : item.conn.window, run.at),
          userId: item.conn.userId,
          connectionId: item.conn.id,
          spentAmount: snapshot.used,
          currency: snapshot.currency,
          count: 1,
        };
        await history.upsertAggregate(aggregate);
      }
      collected += 1;
      nextRuns.push({ connectionId: item.conn.id, at: run.at.toISOString() });
    } catch (err) {
      failed += 1;
      const msg = err instanceof Error ? err.message : String(err);
      const errLine = `[collector] connection=${item.conn.id} (${item.conn.connectorId}) fetch failed: ${msg}`;
      if (logger) logger(errLine);
      else console.error(errLine);
    }
  }

  return {
    collected,
    skipped: skippedNow.length,
    failed,
    nextRuns,
  };
}
