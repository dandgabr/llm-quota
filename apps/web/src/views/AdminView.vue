<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useQuotaStore } from "../stores/quota";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";
import { ApiError } from "../lib/api";

const t = useTranslator();
const quota = useQuotaStore();
const auth = useAuthStore();

const settings = reactive({
  intervalSeconds: 60,
  tlsActive: false,
  tlsManaged: true,
  certPath: null as string | null,
  uptimeSeconds: 0,
  nodeVersion: "",
});

const loading = ref(true);
const saving = ref(false);
const syncing = ref(false);
const notice = ref<string | null>(null);
const syncResult = ref<string | null>(null);
const error = ref<string | null>(null);

async function loadSettings() {
  loading.value = true;
  error.value = null;
  const api = auth.api();
  if (!api) return;
  try {
    const res = await api.getAdminSettings();
    settings.intervalSeconds = Math.round(res.collectIntervalMs / 1000);
    settings.tlsActive = res.tls.active;
    settings.tlsManaged = res.tls.managedByProxy;
    settings.certPath = res.tls.certPath;
    settings.uptimeSeconds = res.instance.uptimeSeconds;
    settings.nodeVersion = res.instance.nodeVersion;
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Failed to load admin settings";
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  notice.value = null;
  error.value = null;
  const api = auth.api();
  if (!api) return;
  try {
    const ms = Math.max(10, settings.intervalSeconds) * 1000;
    await api.updateAdminSettings({ collectIntervalMs: ms });
    notice.value = t("admin.saved");
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Failed to update settings";
  } finally {
    saving.value = false;
  }
}

async function triggerSyncNow() {
  syncing.value = true;
  syncResult.value = null;
  error.value = null;
  const api = auth.api();
  if (!api) return;
  try {
    const res = await api.syncCollectorNow();
    await quota.refreshAll();
    syncResult.value = t("admin.syncResult")
      .replace("{collected}", String(res.result.collected))
      .replace("{skipped}", String(res.result.skipped))
      .replace("{failed}", String(res.result.failed));
  } catch (err) {
    error.value = err instanceof ApiError ? err.message : "Failed to trigger sync";
  } finally {
    syncing.value = false;
  }
}

function formatUptime(sec: number): string {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

onMounted(() => {
  void quota.refreshAll();
  void loadSettings();
});
</script>

<template>
  <section class="admin-view">
    <div class="head">
      <div>
        <span class="micro">{{ t("nav.admin") }}</span>
        <h1>{{ t("admin.title") }}</h1>
      </div>
      <span v-if="settings.uptimeSeconds > 0" class="micro uptime-tag">
        Uptime: {{ formatUptime(settings.uptimeSeconds) }} · Node {{ settings.nodeVersion }}
      </span>
    </div>

    <div v-if="notice" class="card is-raised notice-card" role="status">
      {{ notice }}
    </div>

    <div v-if="syncResult" class="card is-raised sync-result-card" role="status">
      <strong>{{ t("admin.syncSuccess") }}</strong>
      <p class="micro text-muted">{{ syncResult }}</p>
    </div>

    <div v-if="error" class="card is-raised error-card" role="alert">
      {{ error }}
    </div>

    <div class="grid admin-grid">
      <!-- Card 1: Coleta e Sincronização -->
      <article class="card form-card">
        <span class="micro">{{ t("admin.systemSettings") }}</span>
        <h2>{{ t("admin.collector") }}</h2>
        <p class="micro text-muted">{{ t("admin.collectorDesc") }}</p>

        <form @submit.prevent="saveSettings">
          <label>
            {{ t("admin.refreshInterval") }} ({{ t("admin.seconds") }})
            <div class="input-unit-group">
              <input
                v-model.number="settings.intervalSeconds"
                type="number"
                min="10"
                max="3600"
                step="5"
                required
              />
              <span class="unit-label">{{ t("admin.seconds") }}</span>
            </div>
          </label>

          <div class="btn-group">
            <button class="btn btn-primary" type="submit" :disabled="saving">
              {{ saving ? t("admin.saving") : t("admin.save") }}
            </button>
            <button
              class="btn btn-secondary"
              type="button"
              :disabled="syncing"
              @click="triggerSyncNow"
            >
              {{ syncing ? t("admin.syncing") : t("admin.syncNow") }}
            </button>
          </div>
        </form>
      </article>

      <!-- Card 2: Segurança TLS e Criptografia -->
      <article class="card">
        <span class="micro">{{ t("nav.settings") }}</span>
        <h2>{{ t("admin.tls") }}</h2>
        <p class="micro text-muted">{{ t("admin.tlsDesc") }}</p>

        <div class="tls-status-box">
          <div class="status-indicator-row">
            <span class="status-dot" :class="{ 'is-active': settings.tlsActive || settings.tlsManaged }" />
            <strong>{{ settings.tlsActive ? t("admin.tlsActive") : t("admin.tlsManaged") }}</strong>
          </div>
          <p class="micro text-muted">
            {{ settings.certPath ? `Certificado: ${settings.certPath}` : 'Terminação TLS e certificados digitais são gerenciados na borda da rede (Proxy Reverso / Ingress).' }}
          </p>
        </div>
      </article>

      <!-- Card 3: Central de Governança e Usuários -->
      <article class="card">
        <span class="micro">{{ t("admin.title") }}</span>
        <h2>{{ t("admin.users") }}</h2>
        <p class="micro text-muted">
          Gerenciamento central de contas, convites e perfis de acesso da instância.
        </p>

        <div class="stats-row">
          <div>
            <span class="micro">Conexões ativas</span>
            <strong class="stat-num">{{ quota.connections.length }}</strong>
          </div>
        </div>

        <div class="nav-links">
          <RouterLink to="/admin/users" class="btn btn-secondary nav-btn">
            {{ t("admin.users") }} &rarr;
          </RouterLink>
          <RouterLink to="/admin/audit" class="btn btn-ghost nav-btn">
            {{ t("admin.audit") }} &rarr;
          </RouterLink>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--space-6);
}
.uptime-tag {
  background: var(--surface-raised);
  border: var(--border-hairline);
  padding: 4px 8px;
  border-radius: var(--radius-control);
  color: var(--text-secondary);
}
.admin-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--space-6);
}
.input-unit-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.input-unit-group input {
  max-width: 140px;
}
.unit-label {
  color: var(--text-muted);
  font-size: 13px;
}
.btn-group {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-4);
  flex-wrap: wrap;
}
.tls-status-box {
  margin-top: var(--space-4);
  padding: var(--space-3);
  background: var(--surface-raised);
  border-radius: var(--radius-control);
  border: var(--border-hairline);
}
.status-indicator-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
}
.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--status-warning);
}
.status-dot.is-active {
  background: var(--status-success);
}
.notice-card {
  border-left: 3px solid var(--status-success);
  margin-bottom: var(--space-4);
}
.sync-result-card {
  border-left: 3px solid var(--accent-action);
  margin-bottom: var(--space-4);
}
.error-card {
  border-left: 3px solid var(--status-danger);
  margin-bottom: var(--space-4);
}
.stats-row {
  display: flex;
  gap: var(--space-6);
  margin: var(--space-4) 0;
}
.stat-num {
  display: block;
  font-size: 24px;
  font-family: var(--font-display);
}
.nav-links {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.nav-btn {
  text-decoration: none;
}
</style>
