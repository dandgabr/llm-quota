/**
 * Quota window logic.
 *
 * Resolves which quota window applies at a given instant, and derives window
 * boundaries. Domain-pure: no I/O, time injected as `now`.
 */

import type { QuotaWindow } from "@llm-quota/shared";

/**
 * The ordering of quota windows by granularity, from coarsest-lived to shortest.
 * A session window is scoped to an active work session; calendar windows are
 * anchored to real time.
 */
export const WINDOW_ORDER: QuotaWindow[] = ["session", "daily", "weekly", "monthly", "lifetime"];

/** Returns the window for an anchored instant, or null when unknown. */
export function resolveWindow(name: string): QuotaWindow | null {
  return (WINDOW_ORDER as string[]).includes(name) ? (name as QuotaWindow) : null;
}

export interface WindowBoundary {
  /** Inclusive start (ISO instant). */
  start: string;
  /** Exclusive end (ISO instant). */
  end: string;
  /** When this window resets next (ISO instant), if any. */
  resetsAt?: string;
}

const MS_DAY = 86_400_000;
const MS_WEEK = 7 * MS_DAY;

/** Calendar anchor for a daily window (UTC). */
export function dailyBoundary(now: Date): WindowBoundary {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + MS_DAY).toISOString(),
    resetsAt: new Date(start.getTime() + MS_DAY).toISOString(),
  };
}

/** Calendar anchor for a weekly window (UTC, week starts Monday). */
export function weeklyBoundary(now: Date): WindowBoundary {
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((now.getUTCDay() + 6) % 7)),
  );
  return {
    start: start.toISOString(),
    end: new Date(start.getTime() + MS_WEEK).toISOString(),
    resetsAt: new Date(start.getTime() + MS_WEEK).toISOString(),
  };
}

/** Calendar anchor for a monthly window (UTC). */
export function monthlyBoundary(now: Date): WindowBoundary {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString(), resetsAt: end.toISOString() };
}

/** Resolve boundary for a calendar window; session/lifetime return null (provider-defined). */
export function boundaryFor(window: QuotaWindow, now: Date): WindowBoundary | null {
  switch (window) {
    case "daily":
      return dailyBoundary(now);
    case "weekly":
      return weeklyBoundary(now);
    case "monthly":
      return monthlyBoundary(now);
    case "session":
    case "lifetime":
      return null;
  }
}

/** Human-readable key grouping multiple snapshots under a single aggregate slot. */
export function windowKey(window: QuotaWindow, now: Date): string {
  const b = boundaryFor(window, now);
  return b ? `${window}:${b.start}` : window;
}
