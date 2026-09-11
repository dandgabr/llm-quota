<script setup lang="ts">
import { onMounted, reactive } from "vue";
import { useQuotaStore } from "../stores/quota";
import { useAuthStore } from "../stores/auth";

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
  <section>
    <h1>Provider connections</h1>

    <form @submit.prevent="addConnection">
      <label>
        Provider
        <input
          v-model="form.providerId"
          list="providers"
        >
      </label>
      <datalist id="providers">
        <option value="ollama-claude/api" />
        <option value="openrouter/api" />
      </datalist>
      <label>
        Label
        <input
          v-model="form.label"
          placeholder="my team plan"
        >
      </label>
      <label>
        API key
        <input
          v-model="form.secret"
          type="password"
          autocomplete="off"
        >
      </label>
      <button
        type="submit"
        :disabled="!form.secret"
      >
        Add
      </button>
    </form>

    <ul v-if="quota.connections.length">
      <li
        v-for="c in quota.connections"
        :key="c.id"
      >
        <strong>{{ c.label }}</strong> · {{ c.providerKey }} · {{ c.status }}
      </li>
    </ul>
    <p v-else>
      No provider connections yet.
    </p>
  </section>
</template>
