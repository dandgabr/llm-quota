<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { ApiClient } from "../lib/api";
import { useTranslator } from "../lib/i18n";

const t = useTranslator();
const auth = useAuthStore();
const router = useRouter();
const token = ref("");
const role = ref<"user" | "supervisor" | "admin">("user");
const error = ref<string | null>(null);

async function submit() {
  if (!token.value.trim()) {
    error.value = "Enter the session token issued by the API.";
    return;
  }
  const api = new ApiClient(token.value.trim());
  try {
    await api.listSessions();
    auth.login({ token: token.value.trim(), role: role.value });
    void router.push({ name: "dashboard" });
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Login failed";
  }
}
</script>

<template>
  <section class="card login">
    <span class="micro">{{ t("app.title") }}</span>
    <h1>{{ t("auth.login") }}</h1>
    <p class="hint">
      Paste the session token obtained from the API login/OIDC flow (Phase 6).
    </p>

    <form @submit.prevent="submit">
      <label>
        Role (for demo)
        <select v-model="role">
          <option value="user">user</option>
          <option value="supervisor">supervisor</option>
          <option value="admin">admin</option>
        </select>
      </label>
      <label>
        Token
        <input
          v-model="token"
          autocomplete="off"
        >
      </label>
      <button
        type="submit"
        :disabled="!token.trim()"
      >
        {{ t("auth.login") }}
      </button>
    </form>

    <p
      v-if="error"
      class="error"
    >
      {{ error }}
    </p>
    <p class="mfa-note">
      {{ t("auth.mfa.totp") }} · {{ t("auth.mfa.webauthn") }} — server-side (ADR-009), enrollment UI in Phase 7.
    </p>
  </section>
</template>

<style scoped>
.login {
  max-width: 420px;
}
form {
  display: grid;
  gap: var(--space-4);
}
label {
  display: grid;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: 13px;
}
.hint {
  color: var(--text-secondary);
}
.error {
  color: var(--status-danger);
}
.mfa-note {
  color: var(--text-muted);
  font-size: 13px;
}
</style>
