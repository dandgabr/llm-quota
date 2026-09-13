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

onMounted(() => {
  void quota.refreshAll();
});

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
            @change="testFeedback = { status: 'idle' }"
          >
            <option value="ollama-claude/api">Ollama Claude (ollama-claude/api)</option>
            <option value="openrouter/api">OpenRouter (openrouter/api)</option>
          </select>
        </label>
        <label>
          {{ t("connections.label") }}
          <input
            v-model="form.label"
            :placeholder="form.providerId"
          >
        </label>
        <label>
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

        <div class="actions">
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
</style>
