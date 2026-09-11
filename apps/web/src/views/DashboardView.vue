<script setup lang="ts">
import { onMounted } from "vue";
import { useQuotaStore } from "../stores/quota";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";

const t = useTranslator();
const quota = useQuotaStore();
const auth = useAuthStore();

onMounted(() => {
  void quota.refreshAll();
});

const fmtCurrency = (amount?: number, currency?: string): string => {
  if (amount === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency ?? "USD",
  }).format(amount);
};
</script>

<template>
  <section>
    <h1>{{ t("nav.dashboard") }}</h1>
    <p v-if="auth.isAuthenticated">
      Signed in as {{ auth.role }}.
    </p>
    <div v-if="quota.loading">
      {{ t("app.loading") }}
    </div>
    <div v-else-if="quota.error">
      {{ quota.error }}
    </div>
    <div v-else-if="quota.quotas.length === 0">
      No quota data yet.
    </div>
    <ul v-else>
      <li
        v-for="q in quota.quotas"
        :key="q.id"
      >
        <strong>{{ quota.labelOf(q.connectionId) }}</strong>
        — {{ q.kind === "percent" ? `${q.usedPercent}% used` : fmtCurrency(q.usedAmount, q.currency) }}
        ({{ q.remainingPercent }}% remaining)
      </li>
    </ul>
  </section>
</template>
