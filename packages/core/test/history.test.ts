import { describe, expect, it } from "vitest";
import {
  mergeAggregates,
  retentionBoundary,
  rollupSessionBatch,
  snapshotRetentionBoundary,
  type SessionBatch,
} from "../src/index.js";

const now = new Date("2026-09-11T12:00:00Z");

describe("rollupSessionBatch", () => {
  it("produces daily, weekly and monthly aggregates for an in-window record", () => {
    const aggs = rollupSessionBatch(
      {
        userId: "u1",
        connectionId: "c1",
        records: [
          { userId: "u1", connectionId: "c1", window: "daily", spentAmount: 5, currency: "USD", at: "2026-09-10T10:00:00Z" },
        ],
      },
      now,
    );
    const granularities = aggs.map((a) => a.granularity).sort();
    expect(granularities).toEqual(["daily", "monthly", "weekly"]);
    // all aggregates carry the record amount once
    for (const a of aggs) expect(a.spentAmount).toBe(5);
  });

  it("drops records older than the 12-month retention window", () => {
    const aggs = rollupSessionBatch(
      {
        userId: "u1",
        connectionId: "c1",
        records: [
          { userId: "u1", connectionId: "c1", window: "daily", spentAmount: 9, currency: "USD", at: "2010-01-01T00:00:00Z" },
        ],
      },
      now,
    );
    expect(aggs).toHaveLength(0);
  });

  it("merges same-day records into one aggregate per slot (C1)", () => {
    const batch: SessionBatch = {
      userId: "u1",
      connectionId: "c1",
      records: [
        { userId: "u1", connectionId: "c1", window: "daily", spentAmount: 3, currency: "USD", at: "2026-09-10T10:00:00Z" },
        { userId: "u1", connectionId: "c1", window: "daily", spentAmount: 4, currency: "USD", at: "2026-09-10T14:00:00Z" },
      ],
    };
    const aggs = rollupSessionBatch(batch, now);
    const daily = aggs.filter((a) => a.granularity === "daily");
    expect(daily).toHaveLength(1);
    expect(daily[0]?.spentAmount).toBe(7);
    expect(daily[0]?.count).toBe(2);
  });
});

describe("mergeAggregates", () => {
  it("sums amounts and counts", () => {
    const merged = mergeAggregates(
      { granularity: "daily", windowKey: "daily:x", userId: "u1", connectionId: "c1", spentAmount: 3, currency: "USD", count: 1 },
      { granularity: "daily", windowKey: "daily:x", userId: "u1", connectionId: "c1", spentAmount: 4, currency: "USD", count: 2 },
    );
    expect(merged.spentAmount).toBe(7);
    expect(merged.count).toBe(3);
  });
});

describe("retentionBoundary", () => {
  it("is 12 months before now (approx 360 days)", () => {
    const boundary = new Date(retentionBoundary(now));
    expect(now.getTime() - boundary.getTime()).toBeGreaterThan(360 * 86_400_000 - 1000);
  });
});

describe("snapshotRetentionBoundary", () => {
  it("is 7 days before now", () => {
    const boundary = new Date(snapshotRetentionBoundary(now));
    expect(now.getTime() - boundary.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
  });
});
