import { test, expect } from "./support/fixtures.js";

test.beforeEach(async ({ resetStub }) => {
  await resetStub();
});

test.describe("login journey", () => {
  test("unauthenticated deep-link redirects to /login", async ({ seededPage, page }) => {
    await seededPage("/dashboard", { anonymous: true });
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("empty token keeps the submit disabled (no alert path)", async ({ seededPage, page }) => {
    await seededPage("/login", { anonymous: true });
    const submit = page.getByRole("button", { name: /sign in/i });
    await expect(submit).toBeDisabled();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("invalid token surfaces the API error via role=alert", async ({ seededPage, page }) => {
    await seededPage("/login", { anonymous: true });
    await page.getByLabel(/token/i).fill("tok-invalid");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("valid user token lands on the dashboard with the role shown", async ({ seededPage, page }) => {
    await seededPage("/login", { anonymous: true });
    await page.getByLabel(/role/i).selectOption("user");
    await page.getByLabel(/token/i).fill("tok-user");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText(/user/).first()).toBeVisible();
  });

  test("logged-in user visiting /login is bounced to the dashboard", async ({ seededPage, page }) => {
    await seededPage("/login", { role: "user" });
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
