import { expect, test } from "./support/fixtures.js";

/**
 * Phase C — onboarding journeys against the hermetic API stub.
 * The stub exposes POST /__/setup-required to flip first-run state.
 */
test.describe("onboarding", () => {
  test("first run redirects to /setup and completes with the setup code", async ({ page, request }) => {
    await request.post("http://127.0.0.1:3100/__/setup-required", { data: { required: true } });
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);
    await expect(page.getByRole("heading", { name: /create your administrator/i })).toBeVisible();

    await page.getByLabel(/setup code/i).fill("valid-setup-token");
    await page.getByRole("button", { name: /continue/i }).click();
    await page.getByLabel(/email/i).fill("owner@test.local");
    await page.getByLabel("Password", { exact: true }).fill("a-strong-password-1");
    await page.getByLabel("Confirm password", { exact: true }).fill("a-strong-password-1");
    await page.getByRole("button", { name: /create administrator/i }).click();
    await expect(page.getByText(/you're all set/i)).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 5_000 });
  });

  test("invalid setup code surfaces an error", async ({ page, request }) => {
    await request.post("http://127.0.0.1:3100/__/setup-required", { data: { required: true } });
    await page.goto("/setup");
    await page.getByLabel(/setup code/i).fill("wrong-code");
    await page.getByRole("button", { name: /continue/i }).click();
    await page.getByLabel(/email/i).fill("x@test.local");
    await page.getByLabel("Password", { exact: true }).fill("a-strong-password-1");
    await page.getByLabel("Confirm password", { exact: true }).fill("a-strong-password-1");
    await page.getByRole("button", { name: /create administrator/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
  });

  test("an invite link opens the accept wizard", async ({ page, request }) => {
    await request.post("http://127.0.0.1:3100/__/setup-required", { data: { required: false } });
    await page.goto("/invite#token=valid-invite-token");
    await expect(page.getByRole("heading", { name: /accept your invitation/i })).toBeVisible();
    await page.getByLabel("Password", { exact: true }).fill("invitee-password-12");
    await page.getByLabel("Confirm password", { exact: true }).fill("invitee-password-12");
    await page.getByRole("button", { name: /create my account/i }).click();
    await expect(page.getByText(/you're all set/i)).toBeVisible();
  });

  test("an invalid invite shows the expired state", async ({ page, request }) => {
    await request.post("http://127.0.0.1:3100/__/setup-required", { data: { required: false } });
    await page.goto("/invite#token=bad-token");
    await page.getByLabel("Password", { exact: true }).fill("invitee-password-12");
    await page.getByLabel("Confirm password", { exact: true }).fill("invitee-password-12");
    await page.getByRole("button", { name: /create my account/i }).click();
    await expect(page.getByRole("heading", { name: /no longer valid/i })).toBeVisible();
  });
});
