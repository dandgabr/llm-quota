/**
 * Playwright fixtures: fresh localStorage per journey + role seeding.
 */
import { test as base, expect, type Page } from "@playwright/test";

export type Role = "user" | "supervisor" | "admin";

export interface SeedOptions {
  role?: Role;
  theme?: "light" | "dark";
  locale?: "en" | "pt-BR";
  /** Skip seeding the token entirely (anonymous journeys). */
  anonymous?: boolean;
}

async function seedStorage(page: Page, opts: SeedOptions): Promise<void> {
  await page.addInitScript((args) => {
    // One-shot guard: init scripts re-run on every navigation (e.g. reload);
    // without this guard a reload would overwrite user actions like a theme
    // toggle with the seeded values.
    if (localStorage.getItem("llm-quota.seeded") === "1") return;
    localStorage.setItem("llm-quota.seeded", "1");
    localStorage.removeItem("llm-quota.token");
    localStorage.removeItem("llm-quota.role");
    localStorage.removeItem("llm-quota.theme");
    localStorage.removeItem("llm-quota.locale");
    if (args.anonymous) return;
    localStorage.setItem("llm-quota.token", `tok-${args.role ?? "user"}`);
    localStorage.setItem("llm-quota.role", args.role ?? "user");
    if (args.theme) localStorage.setItem("llm-quota.theme", args.theme);
    if (args.locale) localStorage.setItem("llm-quota.locale", args.locale);
  }, opts);
}

export const test = base.extend<{
  /** Navigate with a freshly seeded (or anonymous) storage state; returns the page. */
  seededPage: (url: string, opts?: SeedOptions) => Promise<Page>;
  resetStub: () => Promise<void>;
}>({
  seededPage: async ({ page }, use) => {
    await use(async (url, opts = {}) => {
      await seedStorage(page, opts);
      await page.goto(url);
      return page;
    });
  },
  resetStub: async ({ request }, use) => {
    await use(async () => {
      await request.post("http://127.0.0.1:3100/__/reset");
    });
  },
});

export { expect };
