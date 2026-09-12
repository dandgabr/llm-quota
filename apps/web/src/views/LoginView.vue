<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../stores/auth";
import { PublicApiClient, ApiError } from "../lib/api";
import { useTranslator } from "../lib/i18n";

const t = useTranslator();
const auth = useAuthStore();
const router = useRouter();

const step = ref<"credentials" | "mfa">("credentials");
const email = ref("");
const password = ref("");
const code = ref("");
const challenge = ref("");
const error = ref<string | null>(null);
const submitting = ref(false);

const canSubmitCredentials = computed(() => email.value.includes("@") && password.value.length > 0);
const canSubmitMfa = computed(() => code.value.trim().length > 0);

async function submitCredentials() {
  if (!canSubmitCredentials.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const res = await new PublicApiClient().login({ email: email.value.trim().toLowerCase(), password: password.value });
    password.value = "";
    if ("status" in res && res.status === "mfa_required") {
      challenge.value = res.challenge;
      step.value = "mfa";
      return;
    }
    const session = res as { token: string; user: { role: "user" | "supervisor" | "admin" } };
    auth.login({ token: session.token, role: session.user.role });
    void router.push({ name: "dashboard" });
  } catch (err) {
    error.value = err instanceof ApiError ? t("auth.invalidCredentials") : t("errors.generic");
  } finally {
    submitting.value = false;
  }
}

async function submitMfa() {
  if (!canSubmitMfa.value) return;
  submitting.value = true;
  error.value = null;
  try {
    const session = await new PublicApiClient().loginMfa({ challenge: challenge.value, code: code.value.trim() });
    auth.login({ token: session.token, role: session.user.role });
    void router.push({ name: "dashboard" });
  } catch (err) {
    error.value = err instanceof ApiError && err.status === 410 ? t("auth.mfaExpired") : t("auth.invalidCode");
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section
    class="card login"
    :aria-busy="submitting"
  >
    <span class="micro">{{ t("app.title") }}</span>
    <h1 tabindex="-1">
      {{ t("auth.login") }}
    </h1>

    <template v-if="step === 'credentials'">
      <form @submit.prevent="submitCredentials">
        <label>
          {{ t("auth.email") }}
          <input
            v-model="email"
            type="email"
            autocomplete="username"
            required
          >
        </label>
        <label>
          {{ t("auth.password") }}
          <input
            v-model="password"
            type="password"
            autocomplete="current-password"
            required
          >
        </label>
        <button
          type="submit"
          :disabled="!canSubmitCredentials || submitting"
        >
          {{ submitting ? t("app.loading") : t("auth.login") }}
        </button>
      </form>
    </template>

    <template v-else>
      <p class="hint">
        {{ t("auth.mfaPrompt") }}
      </p>
      <form @submit.prevent="submitMfa">
        <label>
          {{ t("auth.mfaCode") }}
          <input
            v-model="code"
            inputmode="numeric"
            autocomplete="one-time-code"
            required
          >
        </label>
        <button
          type="submit"
          :disabled="!canSubmitMfa || submitting"
        >
          {{ submitting ? t("app.loading") : t("auth.verify") }}
        </button>
      </form>
    </template>

    <p
      v-if="error"
      role="alert"
      class="error"
    >
      {{ error }}
    </p>
  </section>
</template>

<style scoped>
.login {
  max-width: 420px;
  margin: var(--space-11) auto;
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
</style>
