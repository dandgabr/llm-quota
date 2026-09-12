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

  test("empty credentials keep the submit disabled", async ({ seededPage, page }) => {
    await seededPage("/login", { anonymous: true });
    const submit = page.getByRole("button", { name: /sign in/i });
    await expect(submit).toBeDisabled();
  });

  test("invalid credentials surface an error via role=alert", async ({ seededPage, page }) => {
    await seededPage("/login", { anonymous: true });
    await page.getByLabel("Email", { exact: true }).fill("user@test.local");
    await page.getByLabel("Password", { exact: true }).fill("wrong-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("valid credentials land on the dashboard", async ({ seededPage, page }) => {
    await seededPage("/login", { anonymous: true });
    await page.getByLabel("Email", { exact: true }).fill("user@test.local");
    await page.getByLabel("Password", { exact: true }).fill("correct-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("an MFA-enrolled account gets the MFA step", async ({ seededPage, page }) => {
    await seededPage("/login", { anonymous: true });
    await page.getByLabel("Email", { exact: true }).fill("mfa@test.local");
    await page.getByLabel("Password", { exact: true }).fill("correct-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByLabel(/authentication code/i)).toBeVisible();
    await page.getByLabel(/authentication code/i).fill("123456");
    await page.getByRole("button", { name: /verify/i }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("logged-in user visiting /login is bounced to the dashboard", async ({ seededPage, page }) => {
    await seededPage("/login", { role: "user" });
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});
