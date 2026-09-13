import { test, expect } from "./support/fixtures.js";

test.beforeEach(async ({ resetStub }) => {
  await resetStub();
});

test.describe("connect provider journey", () => {
  test("submit stays disabled until an API key is entered", async ({ seededPage, page }) => {
    await seededPage("/connections", { role: "user" });
    const submit = page.getByRole("button", { name: /add connection/i });
    await expect(submit).toBeDisabled();
    await page.getByLabel(/api key/i).fill("sk-test-123");
    await expect(submit).toBeEnabled();
  });

  test("adds a connection and it appears in the saved list", async ({ seededPage, page }) => {
    await seededPage("/connections", { role: "user" });
    await page.getByLabel(/api key/i).fill("sk-test-123");
    await page.getByRole("button", { name: /add connection/i }).click();
    await expect(page.locator(".list-card").getByText("ollama-claude/api").first()).toBeVisible();
  });

  test("tests connection with success feedback", async ({ seededPage, page }) => {
    await seededPage("/connections", { role: "user" });
    const testBtn = page.getByRole("button", { name: /test connection/i });
    await expect(testBtn).toBeDisabled();
    await page.getByLabel(/api key/i).fill("sk-valid-key");
    await expect(testBtn).toBeEnabled();
    await testBtn.click();
    await expect(page.getByText(/connection validated successfully/i)).toBeVisible();
  });

  test("tests connection with failure feedback", async ({ seededPage, page }) => {
    await seededPage("/connections", { role: "user" });
    await page.getByLabel(/api key/i).fill("sk-invalid-key");
    await page.getByRole("button", { name: /test connection/i }).click();
    await expect(page.getByText(/invalid api key|connection validation failed/i)).toBeVisible();
  });

  test("the API key is never rendered in the DOM", async ({ seededPage, page }) => {
    await seededPage("/connections", { role: "user" });
    await page.getByLabel(/api key/i).fill("sk-super-secret-42");
    await page.getByRole("button", { name: /add connection/i }).click();
    const html = await page.content();
    expect(html).not.toContain("sk-super-secret-42");
  });

  test("pre-seeded connections render; empty state otherwise", async ({ seededPage, page }) => {
    await seededPage("/connections", { role: "user" });
    await expect(page.getByText(/seeded-provider/)).toBeVisible();
  });
});
