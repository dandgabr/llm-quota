<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useQuotaStore } from "../stores/quota";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";

const t = useTranslator();
const quota = useQuotaStore();
const auth = useAuthStore();

const form = reactive({
  providerId: "ollama-claude/api",
  label: "",
  connectionType: "api" as "api" | "oauth",
  secret: "",
});

const testing = ref(false);
const testFeedback = ref<{ status: "idle" | "ok" | "error"; message?: string }>({
  status: "idle",
});

const connectingOAuth = ref(false);
const showManualOAuth = ref(false);

onMounted(() => {
  void quota.refreshAll();
  void checkOAuthCallback();
});

function onProviderChange() {
  testFeedback.value = { status: "idle" };
  if (form.providerId === "antigravity/oauth") {
    form.connectionType = "oauth";
  } else {
    form.connectionType = "api";
  }
}

const authCodeInput = ref("");
const exchangingCode = ref(false);
const showCorporateConfig = ref(false);
const corporateClientId = ref("");
const corporateClientSecret = ref("");

async function handleOAuthCode(code: string, state?: string | null) {
  const api = auth.api();
  if (!api) return;

  const expectedState = sessionStorage.getItem("antigravity_oauth_state") || localStorage.getItem("antigravity_oauth_state");
  const codeVerifier = sessionStorage.getItem("antigravity_code_verifier") || localStorage.getItem("antigravity_code_verifier");
  const label = form.label.trim() || sessionStorage.getItem("antigravity_label") || localStorage.getItem("antigravity_label") || "Antigravity";
  const clientId = corporateClientId.value.trim() || sessionStorage.getItem("antigravity_client_id") || localStorage.getItem("antigravity_client_id") || undefined;
  const clientSecret = corporateClientSecret.value.trim() || sessionStorage.getItem("antigravity_client_secret") || localStorage.getItem("antigravity_client_secret") || undefined;

  if (state && expectedState && state !== expectedState) {
    testFeedback.value = { status: "error", message: "Estado de autenticação inválido (CSRF mismatch)." };
    connectingOAuth.value = false;
    return;
  }

  if (!codeVerifier) {
    testFeedback.value = { status: "error", message: "Verificador PKCE não encontrado. Tente novamente." };
    connectingOAuth.value = false;
    return;
  }

  // Limpa estados temporários
  sessionStorage.removeItem("antigravity_oauth_state");
  sessionStorage.removeItem("antigravity_code_verifier");
  sessionStorage.removeItem("antigravity_label");
  sessionStorage.removeItem("antigravity_client_id");
  sessionStorage.removeItem("antigravity_client_secret");
  localStorage.removeItem("antigravity_oauth_state");
  localStorage.removeItem("antigravity_code_verifier");
  localStorage.removeItem("antigravity_label");
  localStorage.removeItem("antigravity_client_id");
  localStorage.removeItem("antigravity_client_secret");

  try {
    await api.callbackAntigravityOAuth({
      code,
      code_verifier: codeVerifier,
      label,
      client_id: clientId,
      client_secret: clientSecret,
    });
    testFeedback.value = { status: "ok", message: t("connections.testSuccess") };
    await quota.refreshAll();
  } catch (err) {
    let msg = t("connections.testFailed");
    if (err && typeof err === "object" && "detail" in err && typeof (err as { detail: unknown }).detail === "string") {
      msg = (err as { detail: string }).detail;
    } else if (err instanceof Error) {
      msg = err.message;
    }
    testFeedback.value = { status: "error", message: msg };
  } finally {
    connectingOAuth.value = false;
  }
}

async function connectAntigravityOAuth() {
  const api = auth.api();
  if (!api) return;
  connectingOAuth.value = true;
  testFeedback.value = { status: "idle" };
  try {
    const customClientId = corporateClientId.value.trim() || undefined;
    const res = await api.getAntigravityAuthUrl(customClientId ? { clientId: customClientId } : undefined);

    // Save in both sessionStorage and localStorage to survive cross-window/popup partition boundaries
    sessionStorage.setItem("antigravity_oauth_state", res.state);
    sessionStorage.setItem("antigravity_code_verifier", res.code_verifier);
    sessionStorage.setItem("antigravity_label", form.label || "Antigravity");
    localStorage.setItem("antigravity_oauth_state", res.state);
    localStorage.setItem("antigravity_code_verifier", res.code_verifier);
    localStorage.setItem("antigravity_label", form.label || "Antigravity");

    if (customClientId) {
      sessionStorage.setItem("antigravity_client_id", customClientId);
      localStorage.setItem("antigravity_client_id", customClientId);
    } else {
      sessionStorage.removeItem("antigravity_client_id");
      localStorage.removeItem("antigravity_client_id");
    }
    if (corporateClientSecret.value.trim()) {
      sessionStorage.setItem("antigravity_client_secret", corporateClientSecret.value.trim());
      localStorage.setItem("antigravity_client_secret", corporateClientSecret.value.trim());
    } else {
      sessionStorage.removeItem("antigravity_client_secret");
      localStorage.removeItem("antigravity_client_secret");
    }

    // Set up message listener on the parent window to receive code from popup
    let messageReceived = false;
    const onOAuthMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === "antigravity_oauth_code" && event.data?.code) {
        messageReceived = true;
        window.removeEventListener("message", onOAuthMessage);
        await handleOAuthCode(event.data.code, event.data.state);
      }
    };
    window.addEventListener("message", onOAuthMessage);

    // Open Google OAuth in a popup window centered on the screen
    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    const popup = window.open(
      res.url,
      "antigravity_oauth_popup",
      `width=${width},height=${height},left=${left},top=${top},status=no,menubar=no,toolbar=no`,
    );

    if (!popup || popup.closed || typeof popup.closed === "undefined") {
      // If popup blocker intervened, redirect current window cleanly
      window.removeEventListener("message", onOAuthMessage);
      window.location.href = res.url;
    } else {
      popup.focus();
      // Poll popup closure: wait slightly after closure to allow postMessage to dispatch
      const timer = setInterval(() => {
        if (popup.closed) {
          clearInterval(timer);
          setTimeout(() => {
            if (!messageReceived) {
              window.removeEventListener("message", onOAuthMessage);
              connectingOAuth.value = false;
            }
          }, 1500);
        }
      }, 1000);
    }
  } catch (err) {
    connectingOAuth.value = false;
    let msg = "Falha ao iniciar OAuth";
    if (err && typeof err === "object" && "detail" in err && typeof (err as { detail: unknown }).detail === "string") {
      msg = (err as { detail: string }).detail;
    } else if (err instanceof Error) {
      msg = err.message;
    }
    testFeedback.value = { status: "error", message: msg };
  }
}

async function exchangeAuthCode() {
  const code = authCodeInput.value.trim();
  if (!code) return;
  const api = auth.api();
  if (!api) return;

  exchangingCode.value = true;
  testFeedback.value = { status: "idle" };

  try {
    let codeVerifier = sessionStorage.getItem("antigravity_code_verifier") || localStorage.getItem("antigravity_code_verifier");
    if (!codeVerifier) {
      // If user navigated directly or pasted code without clicking the OAuth button first,
      // generate/retrieve verifier from the server auth url
      const authInit = await api.getAntigravityAuthUrl();
      codeVerifier = authInit.code_verifier;
    }

    const label = form.label.trim() || sessionStorage.getItem("antigravity_label") || localStorage.getItem("antigravity_label") || "Antigravity";
    const clientId = corporateClientId.value.trim() || sessionStorage.getItem("antigravity_client_id") || localStorage.getItem("antigravity_client_id") || undefined;
    const clientSecret = corporateClientSecret.value.trim() || sessionStorage.getItem("antigravity_client_secret") || localStorage.getItem("antigravity_client_secret") || undefined;

    await api.callbackAntigravityOAuth({
      code,
      code_verifier: codeVerifier,
      label,
      client_id: clientId,
      client_secret: clientSecret,
    });
    authCodeInput.value = "";
    sessionStorage.removeItem("antigravity_oauth_state");
    sessionStorage.removeItem("antigravity_code_verifier");
    sessionStorage.removeItem("antigravity_label");
    sessionStorage.removeItem("antigravity_client_id");
    sessionStorage.removeItem("antigravity_client_secret");
    localStorage.removeItem("antigravity_oauth_state");
    localStorage.removeItem("antigravity_code_verifier");
    localStorage.removeItem("antigravity_label");
    localStorage.removeItem("antigravity_client_id");
    localStorage.removeItem("antigravity_client_secret");
    testFeedback.value = { status: "ok", message: t("connections.testSuccess") };
    await quota.refreshAll();
  } catch (err) {
    let msg = t("connections.testFailed");
    if (err && typeof err === "object" && "detail" in err && typeof (err as { detail: unknown }).detail === "string") {
      msg = (err as { detail: string }).detail;
    } else if (err instanceof Error) {
      msg = err.message;
    }
    testFeedback.value = { status: "error", message: msg };
  } finally {
    exchangingCode.value = false;
  }
}

async function checkOAuthCallback() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get("code");
  const state = urlParams.get("state");
  if (!code) return;

  // Clean query params from URL immediately
  window.history.replaceState({}, document.title, window.location.pathname);

  // If this was loaded inside a popup, notify parent window and close cleanly
  if (window.opener && window.opener !== window) {
    try {
      window.opener.postMessage({ type: "antigravity_oauth_code", code, state }, window.location.origin);
      window.close();
      return;
    } catch {
      // ignore
    }
  }

  // Otherwise, handle it in current window (full page redirect mode)
  await handleOAuthCode(code, state);
}

async function testCurrentConnection() {
  if (!form.secret.trim()) return;
  const api = auth.api();
  if (!api) return;

  testing.value = true;
  testFeedback.value = { status: "idle" };

  try {
    const res = await api.testConnection({
      providerId: form.providerId,
      connectionType: form.connectionType,
      secret: form.secret.trim(),
    });
    if (res.ok) {
      testFeedback.value = { status: "ok", message: t("connections.testSuccess") };
    } else {
      testFeedback.value = { status: "error", message: t("connections.testFailed") };
    }
  } catch (err) {
    let msg = t("connections.testFailed");
    if (err && typeof err === "object" && "detail" in err && typeof (err as { detail: unknown }).detail === "string") {
      msg = (err as { detail: string }).detail;
    } else if (err instanceof Error && err.message) {
      msg = err.message;
    }
    testFeedback.value = { status: "error", message: msg };
  } finally {
    testing.value = false;
  }
}

async function addConnection() {
  const api = auth.api();
  if (!api) return;
  try {
    await api.createConnection({
      providerId: form.providerId,
      label: form.label || form.providerId,
      connectionType: form.connectionType,
      secret: form.secret.trim(),
    });
    form.secret = "";
    form.label = "";
    testFeedback.value = { status: "idle" };
    await quota.refreshAll();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to add connection");
  }
}
const editingId = ref<string | null>(null);
const editForm = reactive({
  label: "",
  secret: "",
});
const editTesting = ref(false);
const editFeedback = ref<{ status: "idle" | "ok" | "error"; message?: string }>({
  status: "idle",
});

function startEdit(conn: { id: string; label: string; providerKey: string }) {
  editingId.value = conn.id;
  editForm.label = conn.label;
  editForm.secret = "";
  editFeedback.value = { status: "idle" };
}

function cancelEdit() {
  editingId.value = null;
  editForm.label = "";
  editForm.secret = "";
  editFeedback.value = { status: "idle" };
}

async function saveEdit(connId: string) {
  try {
    await quota.updateConnection(connId, {
      label: editForm.label.trim() || undefined,
      secret: editForm.secret.trim() || undefined,
    });
    cancelEdit();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to update connection");
  }
}

async function deleteConn(connId: string) {
  if (!confirm(t("connections.deleteConfirm"))) return;
  try {
    await quota.deleteConnection(connId);
    if (editingId.value === connId) cancelEdit();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to delete connection");
  }
}
</script>

<template>
  <section class="grid">
    <div class="card form-card">
      <span class="micro">{{ t("nav.connections") }}</span>
      <h2>{{ t("connections.add") }}</h2>
      <form @submit.prevent="addConnection">
        <label>
          {{ t("connections.title") }}
          <select
            v-model="form.providerId"
            aria-label="provider"
            @change="onProviderChange"
          >
            <option value="ollama-claude/api">Ollama Claude (ollama-claude/api)</option>
            <option value="openrouter/api">OpenRouter (openrouter/api)</option>
            <option value="opencode-go/api">OpenCode Go (opencode-go/api)</option>
            <option value="antigravity/oauth">Google Antigravity (antigravity/oauth)</option>
          </select>
        </label>
        <label>
          {{ t("connections.label") }}
          <input
            v-model="form.label"
            :placeholder="form.providerId"
          >
        </label>

        <!-- Fluxo OAuth quando o provedor é Antigravity -->
        <div v-if="form.providerId === 'antigravity/oauth'" class="oauth-box">
          <div class="oauth-primary">
            <button
              type="button"
              class="btn-primary btn-oauth"
              :disabled="connectingOAuth"
              @click="connectAntigravityOAuth"
            >
              <span class="oauth-icon">⚡</span>
              {{ connectingOAuth ? t("connections.oauthConnecting") : t("connections.oauthConnect") }}
            </button>
          </div>

          <div class="oauth-manual-toggle">
            <button
              type="button"
              class="btn-link"
              @click="showCorporateConfig = !showCorporateConfig"
            >
              {{ showCorporateConfig ? "▲ " + t("connections.oauthCorporateHide") : "⚙️ " + t("connections.oauthCorporateToggle") }}
            </button>
            <button
              type="button"
              class="btn-link"
              @click="showManualOAuth = !showManualOAuth"
            >
              {{ showManualOAuth ? "▲ " + t("connections.oauthManualHide") : "▼ " + t("connections.oauthManualToggle") }}
            </button>
          </div>

          <!-- Configuração Corporativa (Client ID / Secret customizados) -->
          <div v-if="showCorporateConfig" class="oauth-corporate-inputs" style="margin-top: var(--space-2); padding: var(--space-2); background: var(--surface-2, rgba(255,255,255,0.03)); border-radius: var(--radius-sm);">
            <p class="micro text-muted" style="margin-bottom: var(--space-2);">
              {{ t("connections.oauthCorporateDesc") }}
            </p>
            <label style="margin-bottom: var(--space-2);">
              {{ t("connections.oauthCorporateClientId") }}
              <input
                v-model="corporateClientId"
                type="text"
                autocomplete="off"
                placeholder="Ex: 123456789-abc.apps.googleusercontent.com"
              >
            </label>
            <label>
              {{ t("connections.oauthCorporateClientSecret") }}
              <input
                v-model="corporateClientSecret"
                type="password"
                autocomplete="off"
                placeholder="Ex: GOCSPX-..."
              >
            </label>
          </div>

          <div v-if="showManualOAuth" class="oauth-manual-inputs">
            <div class="oauth-manual-group">
              <label>
                {{ t("connections.oauthCodeHint") }}
                <div class="code-exchange-row">
                  <input
                    v-model="authCodeInput"
                    type="text"
                    autocomplete="off"
                    :placeholder="t('connections.oauthCodePlaceholder')"
                  >
                  <button
                    type="button"
                    class="btn-primary btn-sm"
                    :disabled="!authCodeInput.trim() || exchangingCode"
                    @click="exchangeAuthCode"
                  >
                    {{ exchangingCode ? t("connections.oauthConnecting") : t("connections.oauthExchange") }}
                  </button>
                </div>
              </label>
            </div>

            <div class="oauth-manual-group" style="margin-top: var(--space-2);">
              <label>
                {{ t("connections.oauthManualHint") }}
                <input
                  v-model="form.secret"
                  type="password"
                  autocomplete="off"
                  placeholder='{"refresh_token": "..."} ou refresh token'
                  @input="testFeedback = { status: 'idle' }"
                >
              </label>
            </div>
          </div>
        </div>

        <!-- Fluxo Normal de Chave de API -->
        <label v-else>
          {{ t("quota.used") }} · API key
          <input
            v-model="form.secret"
            type="password"
            autocomplete="off"
            aria-label="API key"
            @input="testFeedback = { status: 'idle' }"
          >
        </label>

        <div
          v-if="testFeedback.status !== 'idle'"
          class="feedback-banner"
          :class="testFeedback.status"
          role="status"
          aria-live="polite"
        >
          <span class="micro">{{ testFeedback.status === 'ok' ? '✓' : '✕' }}</span>
          <span>{{ testFeedback.message }}</span>
        </div>

        <div class="actions" v-if="form.providerId !== 'antigravity/oauth' || showManualOAuth">
          <button
            type="button"
            class="btn-ghost"
            :disabled="!form.secret || testing"
            @click="testCurrentConnection"
          >
            {{ testing ? t("connections.testing") : t("connections.test") }}
          </button>
          <button
            type="submit"
            class="btn-primary"
            :disabled="!form.secret || testing"
          >
            {{ t("connections.add") }}
          </button>
        </div>
      </form>
    </div>

    <div class="card list-card">
      <span class="micro">{{ t("connections.title") }}</span>
      <h2>{{ t("empty.saved") }}</h2>
      <ul
        v-if="quota.connections.length"
        class="list"
      >
        <li
          v-for="c in quota.connections"
          :key="c.id"
          class="conn-item"
        >
          <!-- Modo Visualização -->
          <div v-if="editingId !== c.id" class="item-row">
            <div class="item-info">
              <strong class="item-label">{{ c.label }}</strong>
              <span class="micro provider-tag">{{ c.providerKey }}</span>
              <span class="micro status" :class="c.status">{{ t(`connections.status.${c.status}`) || c.status }}</span>
            </div>
            <div class="item-actions">
              <button
                type="button"
                class="btn-ghost btn-sm"
                @click="startEdit(c)"
              >
                {{ t("connections.edit") }}
              </button>
              <button
                type="button"
                class="btn-ghost btn-sm btn-danger"
                @click="deleteConn(c.id)"
              >
                {{ t("connections.delete") }}
              </button>
            </div>
          </div>

          <!-- Modo Edição Inline -->
          <div v-else class="edit-box">
            <div class="edit-inputs">
              <label>
                {{ t("connections.label") }}
                <input v-model="editForm.label" :placeholder="c.providerKey">
              </label>
              <label>
                {{ t("connections.secretOptional") }}
                <input
                  v-model="editForm.secret"
                  type="password"
                  placeholder="••••••••••••"
                  autocomplete="off"
                >
              </label>
            </div>
            <div class="actions edit-actions">
              <button
                type="button"
                class="btn-ghost btn-sm"
                @click="cancelEdit"
              >
                {{ t("connections.cancel") }}
              </button>
              <button
                type="button"
                class="btn-primary btn-sm"
                @click="saveEdit(c.id)"
              >
                {{ t("connections.save") }}
              </button>
            </div>
          </div>
        </li>
      </ul>
      <p
        v-else
        class="empty"
      >
        {{ t("connections.noConnections") }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: 5fr 7fr; /* asymmetry reversed from dashboard */
  gap: var(--space-6);
}
@media (max-width: 720px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
.form-card form {
  display: grid;
  gap: var(--space-4);
}
label {
  display: grid;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: 13px;
}
.actions {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  justify-content: flex-end;
  margin-top: var(--space-2);
}
.feedback-banner {
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-control);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.feedback-banner.ok {
  color: var(--status-success);
  background: var(--surface-base);
  border: 1px solid var(--status-success);
}
.feedback-banner.error {
  color: var(--status-danger);
  background: var(--surface-base);
  border: 1px solid var(--status-danger);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: var(--border-hairline);
}
.status {
  margin-left: auto;
}
.status.ok {
  color: var(--status-success);
}
.status.error {
  color: var(--status-danger);
}
.empty {
  color: var(--text-muted);
}
.conn-item {
  flex-direction: column;
  align-items: stretch !important;
}
.item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
.item-info {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  flex-wrap: wrap;
}
.item-actions {
  display: flex;
  gap: var(--space-2);
}
.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}
.btn-danger {
  color: var(--status-danger) !important;
}
.btn-danger:hover {
  background: var(--status-danger-subtle) !important;
}
.edit-box {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-2) 0;
}
.edit-inputs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}
@media (max-width: 600px) {
  .edit-inputs {
    grid-template-columns: 1fr;
  }
}
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
.oauth-box {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--surface-subtle);
  border-radius: var(--radius-control);
  border: 1px dashed var(--border-color);
}
.oauth-primary {
  display: flex;
  justify-content: center;
}
.btn-oauth {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  justify-content: center;
  padding: 10px 16px;
  font-weight: 500;
}
.oauth-icon {
  font-size: 16px;
}
.oauth-manual-toggle {
  display: flex;
  justify-content: center;
}
.btn-link {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 8px;
}
.btn-link:hover {
  color: var(--text-primary);
  text-decoration: underline;
}
.oauth-manual-inputs {
  margin-top: var(--space-2);
}
.code-exchange-row {
  display: flex;
  gap: var(--space-2);
  align-items: center;
  margin-top: var(--space-1);
}
.code-exchange-row input {
  flex: 1;
}
</style>
