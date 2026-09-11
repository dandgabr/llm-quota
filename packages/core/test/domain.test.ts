import { describe, expect, it } from "vitest";
import {
  summarizeQuota,
  percentUsed,
  summarizeCredits,
  toCreditTotals,
  convertCurrency,
  type CurrencyRateSource,
} from "../src/index.js";

describe("summarizeQuota", () => {
  it("passes through percent quotas", () => {
    const s = summarizeQuota({ kind: "percent", usedPercent: 40, remainingPercent: 60 });
    expect(s.usedPercent).toBe(40);
    expect(s.remainingPercent).toBe(60);
  });

  it("handles account-level credit shape (no limit)", () => {
    const s = summarizeQuota({ kind: "credits", currency: "USD", total: 50 });
    expect(s.kind).toBe("credits");
    expect(s.usedAmount).toBe(0);
    expect(s.remainingPercent).toBe(0);
  });

  it("handles used/limit credit shape", () => {
    const s = summarizeQuota({ kind: "credits", currency: "USD", used: 30, limit: 100 });
    expect(s.usedPercent).toBe(30);
    expect(s.remainingPercent).toBe(70);
    expect(s.usedAmount).toBe(30);
    expect(s.remainingAmount).toBe(70);
  });
});

describe("percentUsed", () => {
  it("computes a percentage from used/total", () => {
    expect(percentUsed(25, 200)).toBe(12.5);
  });
});

describe("summarizeCredits", () => {
  it("clamps negative remaining", () => {
    const s = summarizeCredits(toCreditTotals({ used: 120, limit: 100, currency: "USD" }));
    expect(s.remainingAmount).toBe(0);
    expect(s.usedPercent).toBe(100);
  });
});

describe("convertCurrency", () => {
  const source: CurrencyRateSource = {
    async rateUsdTo(to) {
      if (to === "BRL") return 5.4;
      if (to === "USD") return 1;
      return null;
    },
  };

  it("returns unchanged when source equals target", async () => {
    const r = await convertCurrency({ amount: 10, from: "USD", to: "usd" }, source);
    expect(r?.amount).toBe(10);
    expect(r?.rate).toBe(1);
  });

  it("converts USD to BRL", async () => {
    const r = await convertCurrency({ amount: 10, from: "USD", to: "BRL" }, source);
    expect(r?.amount).toBeCloseTo(54);
    expect(r?.rate).toBeCloseTo(5.4);
  });

  it("returns null for an unsupported target currency", async () => {
    const r = await convertCurrency({ amount: 10, from: "USD", to: "XYZ" }, source);
    expect(r).toBeNull();
  });
});
