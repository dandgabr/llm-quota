import { expect, test } from "./support/fixtures.js";

/**
 * Phase A — user management journeys against the hermetic API stub.
 * Covers the admin panel: list, invite, role change, block and delete.
 */
test.describe("admin user management", () => {
  test("admin sees users and creates an invite link", async ({ seededPage, page }) => {
    await seededPage("/admin/users", { role: "admin" });
    await expect(page.getByRole("heading", { name: /user management/i })).toBeVisible();
    await expect(page.getByText("admin@test.local")).toBeVisible();

    await page.getByRole("button", { name: /invite user/i }).click();
    await page.locator('[data-dialog="invite"] input[type="email"]').fill("new@test.local");
    await page.locator('[data-dialog="invite"] button[type="submit"]').click();
    await expect(page.getByText(/invitation ready/i)).toBeVisible();
    await expect(page.locator('input[readonly]')).toHaveValue(/token=/);
  });

  test("changing a role updates the row", async ({ seededPage, page }) => {
    await seededPage("/admin/users", { role: "admin" });
    const row = page.getByRole("row", { name: /user@test.local/ });
    await row.getByRole("button", { name: /change role/i }).click();
    await page.locator('[data-dialog="role"] select').selectOption("supervisor");
    await page.locator('[data-dialog="role"] button').last().click();
    await expect(page.getByText(/role updated/i)).toBeVisible();
  });

  test("deleting the last admin is blocked with a message", async ({ seededPage, page }) => {
    await seededPage("/admin/users", { role: "admin" });
    const row = page.getByRole("row", { name: /admin@test.local/ });
    await row.getByRole("button", { name: /^delete$/i }).click();
    await page.locator('[data-dialog="delete"] input').fill("admin@test.local");
    await expect(page.locator('[data-dialog="delete"] button.danger-solid')).toBeEnabled();
    await page.locator('[data-dialog="delete"] button.danger-solid').click();
    await expect(page.getByText(/last active administrator/i)).toBeVisible();
  });

  test("Escape closes a dialog and restores focus", async ({ seededPage, page }) => {
    await seededPage("/admin/users", { role: "admin" });
    const trigger = page.getByRole("button", { name: /invite user/i });
    await trigger.click();
    await expect(page.locator('[data-dialog="invite"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-dialog="invite"]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});
