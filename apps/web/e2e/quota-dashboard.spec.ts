import { test, expect } from "./support/fixtures.js";

test.beforeEach(async ({ resetStub }) => {
  await resetStub();
});

test.describe("quota dashboard journey", () => {
  test("hero donut renders the used percent with an accessible label", async ({ seededPage, page }) => {
    await seededPage("/", { role: "user" });
    await expect(page.getByRole("img", { name: /seeded-provider: 72% used/i })).toBeVisible();
    await expect(page.locator(".hero-num")).toHaveText("72%");
  });

  test("remaining percent and reset meta render as micro labels", async ({ seededPage, page }) => {
    await seededPage("/", { role: "user" });
    await expect(page.getByText(/remaining 28%/i)).toBeVisible();
  });

  test("empty state shows when there is no quota data", async ({ request, seededPage, page }) => {
    // /__/empty clears the fixtures (reset re-seeds; empty truly clears).
    await request.post("http://127.0.0.1:3100/__/empty");
    await seededPage("/", { role: "user" });
    await expect(page.getByText(/no quota data yet/i)).toBeVisible();
  });
});
