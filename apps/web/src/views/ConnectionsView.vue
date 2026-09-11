<script setup lang="ts">
import { onMounted, reactive } from "vue";
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

onMounted(() => {
  void quota.refreshAll();
});

async function addConnection() {
  const api = auth.api();
  if (!api) return;
  try {
    await api.createConnection({
      providerId: form.providerId,
      label: form.label || form.providerId,
      connectionType: form.connectionType,
      secret: form.secret,
    });
    form.secret = "";
    form.label = "";
    await quota.refreshAll();
  } catch (err) {
    alert(err instanceof Error ? err.message : "Failed to add connection");
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
          <input
            v-model="form.providerId"
            list="providers"
            aria-label="provider"
          >
        </label>
        <datalist id="providers">
          <option value="ollama-claude/api" />
          <option value="openrouter/api" />
        </datalist>
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
          >
        </label>
        <button
          type="submit"
          :disabled="!form.secret"
        >
          {{ t("connections.add") }}
        </button>
      </form>
    </div>

    <div class="card list-card">
      <span class="micro">{{ t("connections.title") }}</span>
      <h2>Saved</h2>
      <ul
        v-if="quota.connections.length"
        class="list"
      >
        <li
          v-for="c in quota.connections"
          :key="c.id"
        >
          <strong>{{ c.label }}</strong>
          <span class="micro">{{ c.providerKey }}</span>
          <span
            class="micro status"
            :class="c.status"
          >{{ c.status }}</span>
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
</style>
