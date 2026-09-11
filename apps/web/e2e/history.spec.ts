import { test, expect } from "./support/fixtures.js";

test.beforeEach(async ({ resetStub }) => {
  await resetStub();
});

test.describe("history journey", () => {
  test("defaults to daily granularity with the chart rendered", async ({ seededPage, page }) => {
    await seededPage("/history", { role: "user" });
    await expect(page.getByRole("button", { name: /daily/i })).toHaveClass(/is-active/);
    await expect(page.locator("canvas").first()).toBeVisible();
  });

  test("weekly/monthly buttons switch the active granularity", async ({ seededPage, page }) => {
    await seededPage("/history", { role: "user" });
    await page.getByRole("button", { name: /weekly/i }).click();
    await expect(page.getByRole("button", { name: /weekly/i })).toHaveClass(/is-active/);
    await page.getByRole("button", { name: /monthly/i }).click();
    await expect(page.getByRole("button", { name: /monthly/i })).toHaveClass(/is-active/);
  });

  test("the SPA uses the GET alias, never the QUERY method (ADR-008)", async ({ page, seededPage }) => {
    const methods: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/v1/history")) methods.push(req.method());
    });
    await seededPage("/history", { role: "user" });
    await expect(page.locator("canvas").first()).toBeVisible();
    expect(methods.length).toBeGreaterThan(0);
    expect(methods.every((m) => m === "GET")).toBe(true);
  });
});
