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

const statusTone = (pct: number): string => {
  if (pct >= 80) return "danger";
  if (pct >= 50) return "warn";
  return "ok";
};
</script>

<template>
  <section>
    <div class="head">
      <div>
        <span class="micro">{{ t("quota.window.monthly") }} · {{ t("app.title") }}</span>
        <h1>{{ t("nav.dashboard") }}</h1>
        <p
          v-if="auth.isAuthenticated"
          class="signed"
        >
          {{ t("auth.login") }} · {{ auth.role }}
        </p>
      </div>
    </div>

    <div
      v-if="quota.loading"
      class="card"
    >
      {{ t("app.loading") }}
    </div>
    <div
      v-else-if="quota.error"
      class="card is-raised"
    >
      {{ quota.error }}
    </div>
    <div
      v-else-if="quota.quotas.length === 0"
      class="card"
    >
      No quota data yet.
    </div>

    <div
      v-else
      class="grid"
    >
      <article
        v-for="q in quota.quotas"
        :key="q.id"
        class="card quota-card"
        :class="statusTone(q.remainingPercent)"
      >
        <span class="micro">{{ quota.labelOf(q.connectionId) }}</span>
        <strong class="tabular hero-num">
          {{ q.kind === "percent" ? `${q.usedPercent}%` : fmtCurrency(q.usedAmount, q.currency) }}
        </strong>
        <div
          class="track"
          aria-hidden="true"
        >
          <div
            class="fill"
            :style="{ width: `${q.remainingPercent}%` }"
          />
        </div>
        <footer class="meta">
          <span class="micro">{{ t("quota.remaining") }} {{ q.remainingPercent }}%</span>
          <span
            v-if="q.resetAt"
            class="micro tabular"
          >{{ t("quota.reset") }} {{ q.resetAt.slice(0, 10) }}</span>
        </footer>
      </article>
    </div>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  margin-bottom: var(--space-6);
}
.signed {
  margin: 0;
  color: var(--text-secondary);
}
.grid {
  display: grid;
  grid-template-columns: 7fr 5fr; /* controlled asymmetry, ADR-011 */
  gap: var(--space-6);
}
@media (max-width: 720px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
.quota-card {
  position: relative;
}
.hero-num {
  display: block;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(40px, 6vw, 64px);
  line-height: 1.05;
  margin: var(--space-2) 0 var(--space-4);
}
.track {
  height: 6px;
  background: var(--chart-fill-track);
  border-radius: var(--radius-0);
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent-action);
  transition: width var(--transition-fast);
}
.quota-card.ok .fill {
  background: var(--status-success);
}
.quota-card.warn .fill {
  background: var(--status-warning);
}
.quota-card.danger .fill {
  background: var(--status-danger);
}
.meta {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  margin-top: var(--space-4);
}
</style>
