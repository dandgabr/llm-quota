<script setup lang="ts">
import { onMounted } from "vue";
import { useQuotaStore } from "../stores/quota";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";
import QuotaDonut from "../components/QuotaDonut.vue";

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

const statusTone = (rem: number): string => {
  if (rem <= 50) return "danger";
  if (rem <= 70) return "warn";
  return "ok";
};

// "Now" is the first quota (largest share, 7 of the 7:5 split).
const nowQuota = () => quota.quotas[0];
const othersQuota = () => quota.quotas.slice(1);
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

    <!-- Skeleton on first load -->
    <div
      v-if="quota.loading && !quota.loaded"
      class="grid"
      aria-busy="true"
    >
      <div class="card skeleton skeleton-lg" />
      <div class="skeleton-col">
        <div class="card skeleton" />
        <div class="card skeleton" />
      </div>
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
      aria-live="polite"
    >
      <!-- "Now" hero card: 7 of 7:5 -->
      <article
        v-if="nowQuota()"
        class="card quota-card hero"
      >
        <span class="micro">{{ quota.labelOf(nowQuota()!.connectionId) }}</span>
        <div class="hero-body">
          <QuotaDonut
            :percent="nowQuota()!.usedPercent"
            :label="quota.labelOf(nowQuota()!.connectionId)"
          />
          <div>
            <strong class="tabular hero-num">
              {{ nowQuota()!.kind === "percent" ? `${nowQuota()!.usedPercent}%` : fmtCurrency(nowQuota()!.usedAmount, nowQuota()!.currency) }}
            </strong>
            <span class="micro hero-sub">{{ t("quota.remaining") }} {{ nowQuota()!.remainingPercent }}%</span>
          </div>
        </div>
      </article>

      <!-- Remaining quotas: tighter list -->
      <div class="stack">
        <article
          v-for="q in othersQuota()"
          :key="q.id"
          class="card quota-card"
          :class="statusTone(q.remainingPercent)"
        >
          <div class="row">
            <span class="micro">{{ quota.labelOf(q.connectionId) }}</span>
            <span class="micro status">{{ t("quota.used") }} {{ q.usedPercent }}%</span>
          </div>
          <div
            class="track"
            aria-hidden="true"
          >
            <div
              class="fill"
              :style="{ width: `${q.remainingPercent}%` }"
            />
          </div>
        </article>
      </div>
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
.stack {
  display: grid;
  gap: var(--space-4);
}
@media (max-width: 720px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
.hero-body {
  display: flex;
  align-items: center;
  gap: var(--space-6);
}
.hero-num {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(40px, 6vw, 64px);
  line-height: 1.05;
}
.hero-sub {
  display: block;
  margin-top: var(--space-2);
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: var(--space-3);
}
.status {
  color: var(--text-muted);
}
.track {
  height: 6px;
  background: var(--chart-fill-track);
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

/* Skeleton (flat shimmer-less, pure luminance pulse) */
.skeleton {
  background: var(--surface-raised);
  border: var(--border-hairline);
  min-height: 96px;
  animation: pulse 1.4s var(--ease-out-quart) infinite;
}
.skeleton-lg {
  min-height: 180px;
}
.skeleton-col {
  display: grid;
  gap: var(--space-4);
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
</style>
