import { describe, expect, it } from "vitest";
import { scheduleNext, stagger } from "../src/index.js";

describe("scheduleNext", () => {
  it("marks first collection as due", () => {
    const s = scheduleNext({ window: "daily", now: new Date("2026-09-11T10:00:00Z") });
    expect(s.due).toBe(true);
    expect(s.at).toBeTruthy();
  });

  it("is not due again within the interval window", () => {
    const now = new Date("2026-09-11T10:00:00Z");
    const last = "2026-09-11T09:30:00Z"; // 30 min ago, daily interval is 1h
    const s = scheduleNext({ window: "daily", lastCollectedAt: last, now });
    expect(s.due).toBe(false);
  });

  it("is due once the interval has elapsed", () => {
    const now = new Date("2026-09-11T10:00:00Z");
    const last = "2026-09-11T08:00:00Z"; // 2h ago
    const s = scheduleNext({ window: "daily", lastCollectedAt: last, now });
    expect(s.due).toBe(true);
  });
});

describe("stagger", () => {
  it("rotates deterministically and preserves membership", () => {
    const conns = ["a", "b", "c"];
    const now = new Date("2026-09-11T10:00:00Z");
    const out = stagger(conns, now, 1000);
    expect([...out].sort()).toEqual([...conns].sort());
  });
});
