<script setup lang="ts">
import { provide, ref, watch } from "vue";
import { createTranslator } from "@llm-quota/i18n";
import { useTranslator } from "./lib/i18n.js";

const t = useTranslator();
const locale = ref<"en" | "pt-BR">("en");

async function reload(next: "en" | "pt-BR") {
  const nextTranslator = await createTranslator(next);
  provide("t", nextTranslator);
}
void reload(locale.value);

function switchLocale(next: "en" | "pt-BR") {
  locale.value = next;
  localStorage.setItem("llm-quota.locale", next);
  void reload(next);
}

watch(locale, (next) => switchLocale(next));
</script>

<template>
  <div class="shell">
    <header>
      <strong>llm-quota</strong>
      <nav>
        <RouterLink to="/">
          {{ t("nav.dashboard") }}
        </RouterLink>
        <RouterLink to="/connections">
          {{ t("nav.connections") }}
        </RouterLink>
        <RouterLink to="/history">
          {{ t("nav.history") }}
        </RouterLink>
        <RouterLink to="/admin">
          {{ t("nav.admin") }}
        </RouterLink>
      </nav>
      <select
        data-testid="locale-switch"
        :value="locale"
        @change="switchLocale(($event.target as HTMLSelectElement).value as 'en' | 'pt-BR')"
      >
        <option value="en">
          EN
        </option>
        <option value="pt-BR">
          PT-BR
        </option>
      </select>
    </header>
    <main>
      <RouterView />
    </main>
  </div>
</template>
