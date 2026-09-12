<script setup lang="ts">
import { useTranslator } from "../lib/i18n";

const t = useTranslator();
</script>

<template>
  <section class="landing">
    <span class="micro">{{ t("app.tagline") }}</span>
    <h1>{{ t("landing.title") }}</h1>
    <p class="lead">
      {{ t("landing.lead") }}
    </p>
    <div class="cta">
      <RouterLink
        class="btn-ghost cta-primary"
        :to="{ name: 'login' }"
      >
        {{ t("landing.cta") }}
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.landing {
  max-width: 640px;
  margin: var(--space-11) auto;
}
h1 {
  font-size: 40px;
  line-height: 1.1;
  margin: var(--space-3) 0;
}
.lead {
  color: var(--text-secondary);
  font-size: 18px;
  max-width: 52ch;
}
.cta {
  margin-top: var(--space-6);
}
.cta-primary {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--accent-on-accent);
  background: var(--accent-action);
  border-color: transparent;
}
</style>
