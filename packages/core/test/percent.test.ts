import { describe, expect, it } from "vitest";
import { clampFraction, percentRemaining, percentUsed, safeAmount } from "../src/index.js";

describe("percentUsed", () => {
  it("returns 0 for non-positive totals", () => {
    expect(percentUsed(5, 0)).toBe(0);
    expect(percentUsed(5, -1)).toBe(0);
  });

  it("computes a simple percentage", () => {
    expect(percentUsed(50, 100)).toBe(50);
  });

  it("clamps above 100", () => {
    expect(percentUsed(150, 100)).toBe(100);
  });

  it("returns 0 on NaN inputs", () => {
    expect(percentUsed(Number.NaN, 100)).toBe(0);
  });
});

describe("percentRemaining", () => {
  it("computes the complement", () => {
    expect(percentRemaining(30, 100)).toBe(70);
  });

  it("clamps negatives", () => {
    expect(percentRemaining(150, 100)).toBe(0);
  });
});

describe("clampFraction", () => {
  it("clamps into 0..1", () => {
    expect(clampFraction(-0.2)).toBe(0);
    expect(clampFraction(1.5)).toBe(1);
    expect(clampFraction(0.5)).toBe(0.5);
  });
});

describe("safeAmount", () => {
  it("clamps negatives and NaN to 0", () => {
    expect(safeAmount(-3)).toBe(0);
    expect(safeAmount(Number.NaN)).toBe(0);
  });
});
