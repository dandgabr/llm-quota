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
  /** Invite flow: the server derives the email from the token -> hide the field. */
  hideEmail?: boolean;
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
  return props.emailOptional || props.hideEmail || form.email.includes("@");
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
    <label v-if="!hideEmail">
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
        aria-describedby="password-rules"
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

    <div id="password-rules" class="password-checklist">
      <span class="micro">{{ t("onboarding.passwordRulesTitle") }}</span>
      <ul class="checklist">
        <li :class="{ met: form.password.length >= 12 }">
          <span class="icon">{{ form.password.length >= 12 ? "✓" : "○" }}</span>
          {{ t("onboarding.passwordRuleMinLength") }}
          <span v-if="form.password" class="tabular">({{ form.password.length }}/12)</span>
        </li>
        <li :class="{ met: Boolean(form.password && form.confirm && form.password === form.confirm) }">
          <span class="icon">{{ Boolean(form.password && form.confirm && form.password === form.confirm) ? "✓" : "○" }}</span>
          {{ t("onboarding.passwordRuleMatch") }}
        </li>
      </ul>
    </div>

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
.password-checklist {
  display: grid;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  background: var(--surface-base);
  border: var(--border-hairline);
  border-radius: var(--radius-control);
}
.checklist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: var(--space-1);
  font-size: 13px;
  color: var(--text-muted);
}
.checklist li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  transition: color var(--transition-fast);
}
.checklist li.met {
  color: var(--status-success);
}
.checklist .icon {
  font-family: var(--font-mono);
  font-weight: bold;
}
.error {
  color: var(--status-danger);
}
</style>
