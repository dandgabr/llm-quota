import { describe, expect, it } from "vitest";
import type { QuotaKind, QuotaWindow } from "../src/index.js";

describe("shared types", () => {
  it("exposes the quota window vocabulary", () => {
    const windows: QuotaWindow[] = ["session", "daily", "weekly", "monthly", "lifetime"];
    expect(windows).toContain("session");
    expect(windows).toContain("monthly");
  });

  it("exposes the quota kinds", () => {
    const kinds: QuotaKind[] = ["percent", "credits"];
    expect(kinds).toContain("percent");
  });
});
