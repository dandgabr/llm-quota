<script setup lang="ts">
import { computed, onMounted } from "vue";
import { useQuotaStore } from "../stores/quota";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";
import QuotaDonut from "../components/QuotaDonut.vue";
import type { QuotaView } from "../lib/api";

const t = useTranslator();
const quota = useQuotaStore();
const auth = useAuthStore();

onMounted(() => {
  void quota.refreshAll();
});

const fmtCurrency = (amount?: number, currency = "USD"): string => {
  if (amount === undefined) return "—";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(amount);
};

const fmtBrl = (amountUsd?: number): string => {
  if (amountUsd === undefined) return "—";
  const brl = amountUsd * (quota.fxRateUsdToBrl || 5.5);
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(brl);
};

/** Formatação humanizada de contagem regressiva para expiração/reset. */
const formatTimeUntil = (iso?: string, isExpiration = false): string => {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    if (diffMs <= 0) return isExpiration ? t("quota.noExpiration") : t("quota.reset");

    const diffMins = Math.round(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMins / 60);
    const remMins = diffMins % 60;
    const diffDays = Math.floor(diffHours / 24);

    let timeStr = "";
    if (diffMins < 60) {
      timeStr = `em ${diffMins} min`;
    } else if (diffHours < 24) {
      timeStr = remMins > 0 ? `em ${diffHours}h ${remMins}m` : `em ${diffHours}h`;
    } else if (diffDays === 1) {
      timeStr = `em 1 dia`;
    } else if (diffDays < 7) {
      timeStr = `em ${diffDays} dias`;
    } else if (diffDays < 14) {
      timeStr = `em 1 semana`;
    } else {
      const weeks = Math.floor(diffDays / 7);
      timeStr = `em ${weeks} semanas`;
    }

    if (isExpiration) {
      return t("quota.expiresIn").replace("{time}", timeStr);
    }
    return t("quota.resetsIn").replace("{time}", timeStr);
  } catch {
    return "";
  }
};

const statusTone = (rem: number): string => {
  if (rem <= 50) return "danger";
  if (rem <= 70) return "warn";
  return "ok";
};

export interface AccountGroup {
  connectionId: string;
  label: string;
  providerKey: string;
  isCredits: boolean;
  quotas: QuotaView[];
  primaryQuota: QuotaView;
}

/** Agrupa todas as cotas por conta/conexão. */
const groupedAccounts = computed<AccountGroup[]>(() => {
  const map = new Map<string, QuotaView[]>();
  for (const q of quota.quotas) {
    const list = map.get(q.connectionId) ?? [];
    list.push(q);
    map.set(q.connectionId, list);
  }

  const groups: AccountGroup[] = [];
  for (const conn of quota.connections) {
    const connQuotas = map.get(conn.id);
    if (!connQuotas || connQuotas.length === 0) continue;

    // Ordena: session primeiro, depois weekly, daily, monthly
    const sorted = [...connQuotas].sort((a, b) => {
      const order: Record<string, number> = { session: 1, weekly: 2, daily: 3, monthly: 4, lifetime: 5 };
      return (order[a.window ?? ""] ?? 99) - (order[b.window ?? ""] ?? 99);
    });

    const isCredits = sorted.some((q) => q.kind === "credits");
    groups.push({
      connectionId: conn.id,
      label: conn.label || conn.providerKey,
      providerKey: conn.providerKey,
      isCredits,
      quotas: sorted,
      primaryQuota: sorted[0],
    });
  }
  return groups;
});

const heroAccount = computed<AccountGroup | undefined>(() => groupedAccounts.value[0]);
const secondaryAccounts = computed<AccountGroup[]>(() => groupedAccounts.value.slice(1));

const pendingConnections = () => {
  const activeConnIds = new Set(quota.quotas.map((q) => q.connectionId));
  return quota.connections.filter((c) => !activeConnIds.has(c.id));
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
          {{ t("auth.signedInAs") }} · {{ auth.role }}
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

    <!-- Conexões pendentes de sincronização -->
    <div
      v-if="pendingConnections().length > 0"
      class="card pending-card"
    >
      <div class="pending-header">
        <strong>{{ t("connections.pendingSyncTitle") || "Conexões em sincronização ou com erro" }}</strong>
        <span class="micro">{{ pendingConnections().length }}</span>
      </div>
      <p class="micro text-muted">
        {{ t("connections.pendingSyncDesc") || "As seguintes conexões foram cadastradas, mas o provedor ainda não retornou cotas ou a chave precisa de validação:" }}
      </p>
      <ul class="pending-list">
        <li v-for="c in pendingConnections()" :key="c.id">
          <strong>{{ c.label }}</strong>
          <span class="micro window-tag">{{ c.providerKey }}</span>
          <RouterLink to="/connections" class="micro link-action">
            {{ t("connections.edit") }}
          </RouterLink>
        </li>
      </ul>
    </div>

    <div
      v-if="groupedAccounts.length === 0 && pendingConnections().length === 0"
      class="card"
    >
      {{ t("empty.quotas") }}
    </div>

    <div
      v-else-if="groupedAccounts.length > 0"
      class="grid"
      aria-live="polite"
    >
      <!-- HERO ACCOUNT CARD: Primeira conta ou conta em destaque -->
      <article
        v-if="heroAccount"
        class="card quota-card hero"
      >
        <div class="hero-header">
          <div class="account-title-group">
            <strong class="account-label">{{ heroAccount.label }}</strong>
            <span class="micro provider-subtag">{{ heroAccount.providerKey }}</span>
          </div>
          <!-- Tag no header: CRÉDITOS ou ASSINATURA -->
          <span class="micro window-tag">
            {{ heroAccount.isCredits ? t("quota.window.credits") : t("quota.window.subscription") }}
          </span>
        </div>

        <div class="hero-body">
          <!-- Donut principal -->
          <QuotaDonut
            :percent="heroAccount.primaryQuota.usedPercent"
            :value="heroAccount.isCredits ? fmtCurrency(heroAccount.primaryQuota.remainingAmount ?? heroAccount.primaryQuota.usedAmount, heroAccount.primaryQuota.currency) : undefined"
            :label="heroAccount.label"
          />

          <div class="hero-details">
            <!-- Provedor de créditos monetários (OpenRouter): Dólar + Real -->
            <template v-if="heroAccount.isCredits">
              <div class="currency-group">
                <strong class="tabular hero-num">
                  {{ fmtCurrency(heroAccount.primaryQuota.remainingAmount ?? heroAccount.primaryQuota.usedAmount, heroAccount.primaryQuota.currency) }}
                </strong>
                <span class="secondary-currency">
                  / {{ fmtBrl(heroAccount.primaryQuota.remainingAmount ?? heroAccount.primaryQuota.usedAmount) }}
                </span>
              </div>
              <span class="micro hero-sub">
                {{ t("quota.remaining") }} {{ heroAccount.primaryQuota.remainingPercent }}%
                <span v-if="heroAccount.primaryQuota.usedAmount !== undefined">
                  · {{ t("quota.used") }}: {{ fmtCurrency(heroAccount.primaryQuota.usedAmount, heroAccount.primaryQuota.currency) }}
                </span>
              </span>
              <!-- Vencimento / Expiração dos créditos -->
              <span v-if="heroAccount.primaryQuota.resetAt || heroAccount.primaryQuota.resetsAt" class="micro reset-time">
                ⏱ {{ formatTimeUntil(heroAccount.primaryQuota.resetAt || heroAccount.primaryQuota.resetsAt, true) }}
              </span>
            </template>

            <!-- Provedor percentual ou com múltiplas janelas (Ollama Claude, Antigravity, etc.) -->
            <template v-else>
              <!-- Se possuir grupos de modelos (Antigravity: Gemini vs Claude & GPT) -->
              <div v-if="heroAccount.primaryQuota.modelGroups && heroAccount.primaryQuota.modelGroups.length > 0" class="windows-container">
                <div
                  v-for="group in heroAccount.primaryQuota.modelGroups"
                  :key="group.name"
                  class="model-group-block"
                >
                  <div class="model-group-title">
                    <span class="micro group-heading">{{ group.name }}</span>
                    <span v-if="group.models" class="micro text-muted">
                      {{ group.models.join(', ') }}
                    </span>
                  </div>

                  <!-- Janela de Sessão -->
                  <div v-if="group.session" class="window-row">
                    <div class="window-row-header">
                      <span class="micro window-pill">{{ t("quota.window.session") }}</span>
                      <strong class="tabular window-percent">
                        {{ t("quota.used") }} {{ group.session.usedPercent }}%
                      </strong>
                    </div>
                    <div class="track" aria-hidden="true">
                      <div
                        class="fill"
                        :class="statusTone(group.session.remainingPercent)"
                        :style="{ width: `${group.session.usedPercent}%` }"
                      />
                    </div>
                    <div class="window-row-footer">
                      <span class="micro remaining-text">
                        {{ t("quota.remaining") }} {{ group.session.remainingPercent }}%
                      </span>
                      <span v-if="group.session.resetsAt" class="micro reset-time">
                        ⏱ {{ formatTimeUntil(group.session.resetsAt, false) }}
                      </span>
                    </div>
                  </div>

                  <!-- Janela Semanal -->
                  <div v-if="group.weekly" class="window-row">
                    <div class="window-row-header">
                      <span class="micro window-pill">{{ t("quota.window.weekly") }}</span>
                      <strong class="tabular window-percent">
                        {{ t("quota.used") }} {{ group.weekly.usedPercent }}%
                      </strong>
                    </div>
                    <div class="track" aria-hidden="true">
                      <div
                        class="fill"
                        :class="statusTone(group.weekly.remainingPercent)"
                        :style="{ width: `${group.weekly.usedPercent}%` }"
                      />
                    </div>
                    <div class="window-row-footer">
                      <span class="micro remaining-text">
                        {{ t("quota.remaining") }} {{ group.weekly.remainingPercent }}%
                      </span>
                      <span v-if="group.weekly.resetsAt" class="micro reset-time">
                        ⏱ {{ formatTimeUntil(group.weekly.resetsAt, false) }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Padrão sem grupos de modelos (janelas tradicionais) -->
              <div v-else class="windows-container">
                <div
                  v-for="q in heroAccount.quotas"
                  :key="q.id"
                  class="window-row"
                >
                  <div class="window-row-header">
                    <span class="micro window-pill">
                      {{ q.window ? (t(`quota.window.${q.window}`) || q.window) : t("quota.window.session") }}
                    </span>
                    <strong class="tabular window-percent">
                      {{ t("quota.used") }} {{ q.usedPercent }}%
                    </strong>
                  </div>
                  <div class="track" aria-hidden="true">
                    <div
                      class="fill"
                      :class="statusTone(q.remainingPercent)"
                      :style="{ width: `${q.usedPercent}%` }"
                    />
                  </div>
                  <div class="window-row-footer">
                    <span class="micro remaining-text">
                      {{ t("quota.remaining") }} {{ q.remainingPercent }}%
                    </span>
                    <span v-if="q.resetAt || q.resetsAt" class="micro reset-time">
                      ⏱ {{ formatTimeUntil(q.resetAt || q.resetsAt, false) }}
                    </span>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </article>

      <!-- SECONDARY ACCOUNTS: Demais contas agrupadas -->
      <div class="stack">
        <article
          v-for="acc in secondaryAccounts"
          :key="acc.connectionId"
          class="card quota-card account-card"
        >
          <div class="row account-header">
            <div class="account-title-group">
              <strong class="account-label">{{ acc.label }}</strong>
              <span class="micro provider-subtag">{{ acc.providerKey }}</span>
            </div>
            <span class="micro window-tag">
              {{ acc.isCredits ? t("quota.window.credits") : t("quota.window.subscription") }}
            </span>
          </div>

          <!-- Se for crédito de API: valor em destaque e expiração -->
          <div v-if="acc.isCredits" class="credit-account-body">
            <div class="row-values">
              <strong class="credits-val">
                {{ fmtCurrency(acc.primaryQuota.remainingAmount ?? acc.primaryQuota.usedAmount, acc.primaryQuota.currency) }}
                <small class="secondary-currency">/ {{ fmtBrl(acc.primaryQuota.remainingAmount ?? acc.primaryQuota.usedAmount) }}</small>
              </strong>
            </div>
            <span v-if="acc.primaryQuota.resetAt || acc.primaryQuota.resetsAt" class="micro reset-time">
              ⏱ {{ formatTimeUntil(acc.primaryQuota.resetAt || acc.primaryQuota.resetsAt, true) }}
            </span>
          </div>

          <!-- Se possuir grupos de modelos (Antigravity: Gemini vs Claude & GPT) -->
          <div v-else-if="acc.primaryQuota.modelGroups && acc.primaryQuota.modelGroups.length > 0" class="windows-container secondary-windows">
            <div
              v-for="group in acc.primaryQuota.modelGroups"
              :key="group.name"
              class="model-group-block"
            >
              <div class="model-group-title">
                <span class="micro group-heading">{{ group.name }}</span>
                <span v-if="group.models" class="micro text-muted">
                  {{ group.models.join(', ') }}
                </span>
              </div>

              <!-- Janela de Sessão -->
              <div v-if="group.session" class="window-row">
                <div class="window-row-header">
                  <span class="micro window-pill">{{ t("quota.window.session") }}</span>
                  <span class="micro status">{{ t("quota.used") }} {{ group.session.usedPercent }}%</span>
                </div>
                <div class="track" aria-hidden="true">
                  <div
                    class="fill"
                    :class="statusTone(group.session.remainingPercent)"
                    :style="{ width: `${group.session.usedPercent}%` }"
                  />
                </div>
                <div class="window-row-footer">
                  <span class="micro remaining-text">
                    {{ t("quota.remaining") }} {{ group.session.remainingPercent }}%
                  </span>
                  <span v-if="group.session.resetsAt" class="micro reset-time">
                    ⏱ {{ formatTimeUntil(group.session.resetsAt, false) }}
                  </span>
                </div>
              </div>

              <!-- Janela Semanal -->
              <div v-if="group.weekly" class="window-row">
                <div class="window-row-header">
                  <span class="micro window-pill">{{ t("quota.window.weekly") }}</span>
                  <span class="micro status">{{ t("quota.used") }} {{ group.weekly.usedPercent }}%</span>
                </div>
                <div class="track" aria-hidden="true">
                  <div
                    class="fill"
                    :class="statusTone(group.weekly.remainingPercent)"
                    :style="{ width: `${group.weekly.usedPercent}%` }"
                  />
                </div>
                <div class="window-row-footer">
                  <span class="micro remaining-text">
                    {{ t("quota.remaining") }} {{ group.weekly.remainingPercent }}%
                  </span>
                  <span v-if="group.weekly.resetsAt" class="micro reset-time">
                    ⏱ {{ formatTimeUntil(group.weekly.resetsAt, false) }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- Se forem janelas múltiplas (Ollama, etc.): lista harmoniosa de janelas -->
          <div v-else class="windows-container secondary-windows">
            <div
              v-for="q in acc.quotas"
              :key="q.id"
              class="window-row"
            >
              <div class="window-row-header">
                <span class="micro window-pill">
                  {{ q.window ? (t(`quota.window.${q.window}`) || q.window) : t("quota.window.session") }}
                </span>
                <span class="micro status">{{ t("quota.used") }} {{ q.usedPercent }}%</span>
              </div>
              <div class="track" aria-hidden="true">
                <div
                  class="fill"
                  :class="statusTone(q.remainingPercent)"
                  :style="{ width: `${q.usedPercent}%` }"
                />
              </div>
              <div class="window-row-footer">
                <span class="micro remaining-text">
                  {{ t("quota.remaining") }} {{ q.remainingPercent }}%
                </span>
                <span v-if="q.resetAt || q.resetsAt" class="micro reset-time">
                  ⏱ {{ formatTimeUntil(q.resetAt || q.resetsAt, false) }}
                </span>
              </div>
            </div>
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
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  align-items: start;
  gap: var(--space-6);
}
.hero {
  grid-column: 1 / -1;
}
@media (min-width: 1200px) {
  .hero {
    grid-column: span 1;
  }
}
.stack {
  display: contents;
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
.hero-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: var(--space-2);
}
.window-tag, .window-subtag {
  background: var(--surface-raised);
  border: var(--border-hairline);
  padding: 2px 6px;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
}
.currency-group {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.secondary-currency {
  font-size: 0.5em;
  color: var(--text-secondary);
  font-weight: 500;
}
.reset-time {
  display: block;
  margin-top: var(--space-2);
  color: var(--text-muted);
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: var(--space-3);
}
.row-label {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.row-values {
  text-align: right;
}
.credits-val {
  font-family: var(--font-mono);
  font-size: 14px;
}
.card-footer {
  margin-top: var(--space-2);
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

/* Account grouping styles */
.account-title-group {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}
.account-label {
  font-size: 16px;
  font-weight: 600;
}
.provider-subtag {
  color: var(--text-muted);
}
.windows-container {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
}
.model-group-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-bottom: var(--space-2);
  border-bottom: var(--border-hairline);
}
.model-group-block:last-child {
  border-bottom: none;
  padding-bottom: 0;
}
.model-group-title {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
}
.group-heading {
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--text-secondary);
}
.window-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.window-row-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.window-pill {
  background: var(--surface-raised);
  border: var(--border-hairline);
  padding: 1px 6px;
  border-radius: var(--radius-control);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
}
.window-row-footer {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.remaining-text {
  color: var(--text-muted);
  font-size: 12px;
}
.credit-account-body {
  margin-top: var(--space-2);
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
.pending-card {
  border: 1px dashed var(--status-warning);
  background: var(--surface-base);
  margin-bottom: var(--space-4);
}
.pending-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--space-2);
}
.pending-list {
  list-style: none;
  margin: var(--space-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.pending-list li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: var(--border-hairline);
}
.link-action {
  margin-left: auto;
  color: var(--accent-action);
  text-decoration: underline;
}
</style>
