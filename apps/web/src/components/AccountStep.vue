<script setup lang="ts">
/**
 * Shared account-credentials step used by SetupWizard and InviteWizard.
 * Emits the collected values; the parent orchestrates submission.
 */
import { reactive, watch } from "vue";
import { useTranslator } from "../lib/i18n";

const t = useTranslator();

const props = defineProps<{
  /** Email to pre-fill and lock (invite flow); empty for first-admin setup. */
  lockedEmail?: string;
  /** Email is supplied by the server (invite accept) -> don't require it. */
  emailOptional?: boolean;
  submitLabel: string;
  busy?: boolean;
}>();
const emit = defineEmits<{
  submit: [value: { email: string; password: string; firstName: string; lastName: string }];
}>();

const form = reactive({ email: props.lockedEmail ?? "", password: "", confirm: "", firstName: "", lastName: "" });
watch(
  () => props.lockedEmail,
  (v) => {
    if (v !== undefined) form.email = v;
  },
);

function validEmail(): boolean {
  return props.emailOptional || form.email.includes("@");
}

function onSubmit() {
  if (form.password !== form.confirm || form.password.length < 12 || !validEmail()) return;
  emit("submit", {
    email: form.email.trim().toLowerCase(),
    password: form.password,
    firstName: form.firstName,
    lastName: form.lastName,
  });
}
</script>

<template>
  <form @submit.prevent="onSubmit">
    <label>
      {{ t("onboarding.email") }}
      <input
        v-model="form.email"
        type="email"
        autocomplete="username"
        :readonly="Boolean(lockedEmail)"
        :required="!emailOptional"
      >
    </label>
    <label>
      {{ t("onboarding.firstName") }}
      <input v-model="form.firstName" autocomplete="given-name">
    </label>
    <label>
      {{ t("onboarding.lastName") }}
      <input v-model="form.lastName" autocomplete="family-name">
    </label>
    <label>
      {{ t("onboarding.password") }}
      <input
        v-model="form.password"
        type="password"
        autocomplete="new-password"
        minlength="12"
        required
      >
    </label>
    <label>
      {{ t("onboarding.confirmPassword") }}
      <input
        v-model="form.confirm"
        type="password"
        autocomplete="new-password"
        required
      >
    </label>
    <p
      v-if="form.confirm && form.password !== form.confirm"
      class="error"
      role="alert"
    >
      {{ t("onboarding.passwordMismatch") }}
    </p>
    <button
      type="submit"
      :disabled="busy || form.password !== form.confirm || form.password.length < 12"
    >
      {{ submitLabel }}
    </button>
  </form>
</template>

<style scoped>
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
.error {
  color: var(--status-danger);
}
</style>
