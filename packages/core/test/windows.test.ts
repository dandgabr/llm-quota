import { describe, expect, it } from "vitest";
import { dailyBoundary, monthlyBoundary, weeklyBoundary, windowKey } from "../src/index.js";

describe("dailyBoundary", () => {
  it("anchors a day with an inclusive start and exclusive end (UTC)", () => {
    const now = new Date("2026-09-11T15:30:00Z");
    const b = dailyBoundary(now);
    expect(b.start).toBe("2026-09-11T00:00:00.000Z");
    expect(b.end).toBe("2026-09-12T00:00:00.000Z");
    expect(b.resetsAt).toBe("2026-09-12T00:00:00.000Z");
  });
});

describe("weeklyBoundary", () => {
  it("anchors a week starting Monday (2026-09-11 is a Friday)", () => {
    const now = new Date("2026-09-11T15:30:00Z");
    const b = weeklyBoundary(now);
    expect(b.start).toBe("2026-09-07T00:00:00.000Z");
    expect(b.end).toBe("2026-09-14T00:00:00.000Z");
  });
});

describe("monthlyBoundary", () => {
  it("anchors a month boundary", () => {
    const now = new Date("2026-09-11T15:30:00Z");
    const b = monthlyBoundary(now);
    expect(b.start).toBe("2026-09-01T00:00:00.000Z");
    expect(b.end).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("windowKey", () => {
  it("groups snapshots under a calendar slot", () => {
    const now = new Date("2026-09-11T12:00:00Z");
    expect(windowKey("daily", now)).toBe("daily:2026-09-11T00:00:00.000Z");
  });
});
