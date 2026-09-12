<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useTranslator } from "../lib/i18n";
import { useAuthStore } from "../stores/auth";
import { ApiError, PublicApiClient } from "../lib/api";
import AccountStep from "../components/AccountStep.vue";

const t = useTranslator();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const inviteToken = ref("");
const expired = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);
const done = ref(false);

onMounted(() => {
  // The raw token is delivered in the URL fragment; read it and strip it from
  // the address bar so it never lands in history/referrer.
  const fragment = window.location.hash;
  const match = /token=([^&]+)/.exec(fragment);
  if (match?.[1]) {
    inviteToken.value = decodeURIComponent(match[1]);
    history.replaceState(null, "", route.path);
  }
});

async function submit(value: { email: string; password: string; firstName: string; lastName: string }) {
  busy.value = true;
  error.value = null;
  try {
    const res = await new PublicApiClient().acceptInvite({
      token: inviteToken.value,
      password: value.password,
      firstName: value.firstName || undefined,
      lastName: value.lastName || undefined,
    });
    auth.login({ token: res.token, role: res.user.role });
    done.value = true;
    setTimeout(() => void router.push({ name: "dashboard" }), 800);
  } catch (err) {
    if (err instanceof ApiError && err.code === "invite-expired") expired.value = true;
    else error.value = t("onboarding.inviteError");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="wizard">
    <div
      v-if="done"
      class="card"
      role="status"
    >
      <h1>{{ t("onboarding.doneTitle") }}</h1>
      <p>{{ t("onboarding.doneBody") }}</p>
    </div>

    <div
      v-else-if="expired"
      class="card"
    >
      <h1>{{ t("onboarding.inviteExpiredTitle") }}</h1>
      <p class="hint">
        {{ t("onboarding.inviteExpiredBody") }}
      </p>
    </div>

    <div
      v-else
      class="card"
    >
      <span class="micro">{{ t("onboarding.inviteTitle") }}</span>
      <h1>{{ t("onboarding.inviteAccountTitle") }}</h1>
      <p class="hint">
        {{ t("onboarding.inviteAccountHint") }}
      </p>
      <p
        v-if="!inviteToken"
        class="error"
        role="alert"
      >
        {{ t("onboarding.inviteMissing") }}
      </p>
      <p
        v-else-if="error"
        class="error"
        role="alert"
      >
        {{ error }}
      </p>
      <AccountStep
        v-if="inviteToken"
        :email-optional="true"
        :submit-label="t('onboarding.acceptInvite')"
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
}
.hint {
  color: var(--text-muted);
}
.error {
  color: var(--status-danger);
}
</style>
