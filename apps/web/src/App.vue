<script setup lang="ts">
import { reactive, watch } from "vue";
import { useRouter } from "vue-router";
import { createTranslator } from "@llm-quota/i18n";
import { useTranslator, setTranslator } from "./lib/i18n.js";
import { theme } from "./lib/theme.js";
import { useAuthStore } from "./stores/auth.js";
import { safeGetItem, safeSetItem } from "./lib/storage.js";

const t = useTranslator();
const auth = useAuthStore();
const router = useRouter();
const ui = reactive({
  locale: (safeGetItem("llm-quota.locale") as "en" | "pt-BR") ?? "en",
});
const { ui: themeUi, toggle, init } = theme;

// Apply the persisted/system theme before first paint.
init();

// Load the translator synchronously at setup and on every locale switch.
async function load(next: "en" | "pt-BR") {
  setTranslator(await createTranslator(next));
}
void load(ui.locale);
watch(
  () => ui.locale,
  (next) => void load(next),
);

function switchLocale(next: "en" | "pt-BR") {
  ui.locale = next;
  safeSetItem("llm-quota.locale", next);
}

function logout() {
  auth.logout();
  void router.push({ name: "login" });
}
</script>

<template>
  <div class="shell">
    <header class="topbar">
      <strong class="brand">{{ t("app.title") }}</strong>
      <nav
        v-if="auth.isAuthenticated"
        class="nav"
      >
        <RouterLink to="/">{{ t("nav.dashboard") }}</RouterLink>
        <RouterLink to="/connections">{{ t("nav.connections") }}</RouterLink>
        <RouterLink to="/history">{{ t("nav.history") }}</RouterLink>
        <RouterLink
          v-if="auth.isAdmin"
          to="/admin"
        >
          {{ t("nav.admin") }}
        </RouterLink>
        <RouterLink
          v-if="auth.isAdmin"
          to="/admin/users"
        >
          {{ t("admin.users") }}
        </RouterLink>
      </nav>
      <span class="controls">
        <button class="btn-ghost" type="button" aria-label="Toggle color theme" @click="toggle()">
          {{ themeUi.theme === "dark" ? "◐ dark" : "◐ light" }}
        </button>
        <select
          class="locale"
          data-testid="locale-switch"
          :value="ui.locale"
          aria-label="Language"
          @change="switchLocale(($event.target as HTMLSelectElement).value as 'en' | 'pt-BR')"
        >
          <option value="en">
            EN
          </option>
          <option value="pt-BR">
            PT-BR
          </option>
        </select>
        <button
          v-if="auth.isAuthenticated"
          class="btn-ghost"
          type="button"
          @click="logout"
        >
          {{ t("auth.logout") }}
        </button>
      </span>
    </header>
    <main class="content">
      <RouterView />
    </main>
  </div>
</template>

<style scoped>
.shell {
  max-width: 1080px;
  margin: 0 auto;
  padding: var(--space-4);
}
.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-4) var(--space-8);
  padding-bottom: var(--space-4);
  border-bottom: var(--border-hairline);
  margin-bottom: var(--space-8);
}
.brand {
  font-family: var(--font-display);
  font-size: 20px;
  letter-spacing: -0.01em;
  white-space: nowrap;
}
.nav {
  display: flex;
  gap: var(--space-6);
  margin-left: auto;
}
.nav a {
  color: var(--text-secondary);
  font-weight: 500;
}
.nav a:hover {
  color: var(--text-primary);
  text-decoration: none;
}
.nav a.router-link-exact-active {
  color: var(--accent-action);
}
.controls {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}
.locale {
  width: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.content {
  display: grid;
  gap: var(--space-6);
}
</style>
