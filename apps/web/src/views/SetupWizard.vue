<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useTranslator } from "../lib/i18n";
import { useAuthStore } from "../stores/auth";
import { ApiError, PublicApiClient } from "../lib/api";
import { setSetupRequired } from "../router/index.js";
import { safeGetItem } from "../lib/storage.js";
import AccountStep from "../components/AccountStep.vue";

const t = useTranslator();
const auth = useAuthStore();
const router = useRouter();

const step = ref<"token" | "account">("token");
const token = ref("");
const error = ref<string | null>(null);
const busy = ref(false);
const done = ref(false);

onMounted(async () => {
  // If setup is already complete, send the user to login.
  try {
    const status = await new PublicApiClient().setupStatus();
    if (!status.required) void router.replace({ name: "login" });
  } catch {
    // offline/stub: keep the wizard visible
  }
});

function next() {
  if (!token.value.trim()) return;
  error.value = null;
  step.value = "account";
}

async function submit(value: { email: string; password: string; firstName: string; lastName: string }) {
  busy.value = true;
  error.value = null;
  try {
    const res = await new PublicApiClient().setup({
      token: token.value.trim(),
      email: value.email,
      password: value.password,
      firstName: value.firstName || undefined,
      lastName: value.lastName || undefined,
      locale: (safeGetItem("llm-quota.locale") as string | null) ?? undefined,
    });
    auth.login({ token: res.token, role: res.user.role });
    setSetupRequired(false);
    done.value = true;
    setTimeout(() => void router.push({ name: "dashboard" }), 800);
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // Already initialized: send to login.
      setSetupRequired(false);
      void router.replace({ name: "login" });
      return;
    }
    error.value = err instanceof ApiError && err.status === 403 ? t("onboarding.invalidSetupCode") : t("onboarding.setupError");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="wizard">
    <ol
      class="steps micro"
      :aria-label="t('onboarding.progress')"
    >
      <li :aria-current="step === 'token' ? 'step' : undefined">
        {{ t("onboarding.stepToken") }}
      </li>
      <li :aria-current="step === 'account' ? 'step' : undefined">
        {{ t("onboarding.stepAccount") }}
      </li>
    </ol>

    <div
      v-if="done"
      class="card"
      role="status"
    >
      <h1>{{ t("onboarding.doneTitle") }}</h1>
      <p>{{ t("onboarding.doneBody") }}</p>
    </div>

    <div
      v-else-if="step === 'token'"
      class="card"
    >
      <span class="micro">{{ t("onboarding.title") }}</span>
      <h1>{{ t("onboarding.welcomeTitle") }}</h1>
      <p class="hint">
        {{ t("onboarding.tokenHint") }}
      </p>
      <form @submit.prevent="next">
        <label>
          {{ t("onboarding.setupCode") }}
          <input
            v-model="token"
            autocomplete="off"
            required
            aria-describedby="token-help"
          >
        </label>
        <p
          id="token-help"
          class="hint"
        >
          {{ t("onboarding.tokenHelp") }}
        </p>
        <button
          type="submit"
          :disabled="!token.trim()"
        >
          {{ t("onboarding.continue") }}
        </button>
      </form>
    </div>

    <div
      v-else
      class="card"
    >
      <span class="micro">{{ t("onboarding.stepAccount") }}</span>
      <h1>{{ t("onboarding.accountTitle") }}</h1>
      <p class="hint">
        {{ t("onboarding.accountHint") }}
      </p>
      <p
        v-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>
      <AccountStep
        :submit-label="t('onboarding.createAdmin')"
        :busy="busy"
        @submit="submit"
      />
    </div>
  </section>
</template>

<style scoped>
.wizard {
  max-width: 520px;
  margin: var(--space-11) auto;
  display: grid;
  gap: var(--space-4);
}
.steps {
  display: flex;
  gap: var(--space-4);
  list-style: none;
  margin: 0;
  padding: 0;
}
.steps li[aria-current="step"] {
  color: var(--accent-action);
}
.hint {
  color: var(--text-muted);
}
.error {
  color: var(--status-danger);
}
</style>
