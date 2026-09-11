<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { ApiClient } from "../lib/api";

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
  // Validate the token is accepted by the API (session/self check).
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
  <section>
    <h1>Sign in</h1>
    <p>Paste the session token obtained from the API login/OIDC flow (Phase 6).</p>
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
      <button type="submit">
        Sign in
      </button>
    </form>
    <p v-if="error">
      {{ error }}
    </p>
    <p>
      MFA: TOTP + WebAuthn flows are wired server-side (ADR-009); the challenge
      enrollment UI lands with a real IdP in Phase 7.
    </p>
  </section>
</template>
