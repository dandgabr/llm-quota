/**
 * Collect-schedule policy: decides when the next quota collection should run
 * per connection/window, minimizing polling. The async runner and queues land
 * in Phase 5; this module is pure scheduling logic.
 */

import type { QuotaWindow } from "@llm-quota/shared";
import { dailyBoundary, monthlyBoundary, weeklyBoundary } from "./windows.js";

/** How often, in ms, a collection task is eligible per window granularity. */
export const COLLECTION_INTERVALS: Record<QuotaWindow, number> = {
  session: 5 * 60_000, // every 5 minutes during a session
  daily: 60 * 60_000, // hourly
  weekly: 6 * 60 * 60_000, // every 6h
  monthly: 12 * 60 * 60_000, // every 12h
  lifetime: 24 * 60 * 60_000, // daily
};

export interface ScheduleInput {
  lastCollectedAt?: string;
  window: QuotaWindow;
  now: Date;
}

export interface NextRun {
  due: boolean;
  /** Suggested next collection instant (ISO). */
  at?: string;
}

/**
 * Decide whether a collection is due and when the next one should be.
 * Respects the per-window interval, and for calendar windows forces a collect
 * once the period has reset since the last read (start of current period passes
 * the last collected time).
 */
export function scheduleNext(input: ScheduleInput): NextRun {
  const interval = COLLECTION_INTERVALS[input.window];
  const now = input.now.getTime();

  // For calendar windows, the START of the current period bounds a collect:
  // if the last read predates it, the quota has reset and we must re-read.
  let periodStart: number | null = null;
  if (input.window === "daily") periodStart = Date.parse(dailyBoundary(input.now).start);
  if (input.window === "weekly") periodStart = Date.parse(weeklyBoundary(input.now).start);
  if (input.window === "monthly") periodStart = Date.parse(monthlyBoundary(input.now).start);

  if (!input.lastCollectedAt) {
    return { due: true, at: new Date(now + interval).toISOString() };
  }

  const last = Date.parse(input.lastCollectedAt) || 0;
  const intervalDue = now >= last + interval;
  const resetPending = periodStart !== null && last < periodStart;

  // Due when the interval elapsed OR the period reset since the last read.
  const due = intervalDue || resetPending;

  // Next suggested instant: earliest of the interval deadline and (for calendar
  // windows) just after the period start.
  const next = new Date(Math.max(now, last + interval)).toISOString();
  return { due, at: next };
}

/** A staggered collection slot for a connection. */
export interface StaggeredRun {
  connectionId: string;
  at: Date;
}

/**
 * Stagger connections so simultaneous collection spreads across a window.
 * Rotates the order deterministically by day (avoid thundering herd) and
 * distributes each connection at `i * spreadMs` after `now`.
 */
export function stagger(
  connections: string[],
  now: Date,
  spreadMs: number,
): StaggeredRun[] {
  if (connections.length === 0) return [];
  if (spreadMs <= 0) {
    return connections.map((c) => ({ connectionId: c, at: now }));
  }
  // Deterministic rotation by day of year so the order shifts daily.
  const dayOfYear = Math.floor((now.getTime() - Date.UTC(now.getUTCFullYear(), 0, 0)) / 86_400_000);
  const offset = dayOfYear % connections.length;
  const rotated = [...connections.slice(offset), ...connections.slice(0, offset)];
  const startMs = now.getTime();
  return rotated.map((connectionId, i) => ({
    connectionId,
    at: new Date(startMs + i * spreadMs),
  }));
}
