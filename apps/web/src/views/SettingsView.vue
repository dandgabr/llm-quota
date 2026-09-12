<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";
import { ApiError } from "../lib/api";

const t = useTranslator();
const auth = useAuthStore();

const sessions = ref<{ id: string; createdAt: string }[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

// MFA enrollment state
const enrolling = ref(false);
const enrollSecret = ref("");
const enrollUri = ref("");
const enrollCode = ref("");
const recoveryCodes = ref<string[]>([]);

// Step-up password shared by the sensitive actions
const currentPassword = ref("");
const busy = ref(false);

async function loadSessions() {
  const api = auth.api();
  if (!api) return;
  try {
    sessions.value = await api.listSessions();
  } catch (err) {
    error.value = err instanceof ApiError ? t("settings.loadError") : t("errors.generic");
  }
}

async function startEnroll() {
  const api = auth.api();
  if (!api || !currentPassword.value) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await api.enrollTotp(currentPassword.value);
    enrollSecret.value = res.secret;
    enrollUri.value = res.uri;
    enrolling.value = true;
  } catch (err) {
    error.value = err instanceof ApiError && err.status === 401 ? t("settings.passwordWrong") : t("errors.generic");
  } finally {
    busy.value = false;
  }
}

async function confirmEnroll() {
  const api = auth.api();
  if (!api || !enrollCode.value.trim()) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await api.verifyTotp(enrollCode.value.trim());
    recoveryCodes.value = res.recoveryCodes;
    notice.value = t("settings.mfaEnabled");
    enrolling.value = false;
    currentPassword.value = "";
  } catch {
    error.value = t("settings.codeWrong");
  } finally {
    busy.value = false;
  }
}

async function disableMfa() {
  const api = auth.api();
  if (!api || !currentPassword.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api.disableTotp(currentPassword.value);
    notice.value = t("settings.mfaDisabled");
    currentPassword.value = "";
  } catch (err) {
    error.value = err instanceof ApiError && err.status === 401 ? t("settings.passwordWrong") : t("errors.generic");
  } finally {
    busy.value = false;
  }
}

async function regenerate() {
  const api = auth.api();
  if (!api || !currentPassword.value) return;
  busy.value = true;
  error.value = null;
  try {
    const res = await api.regenerateRecoveryCodes(currentPassword.value);
    recoveryCodes.value = res.recoveryCodes;
    notice.value = t("settings.codesRegenerated");
  } catch (err) {
    error.value = err instanceof ApiError && err.status === 401 ? t("settings.passwordWrong") : t("errors.generic");
  } finally {
    busy.value = false;
  }
}

function fmt(iso: string): string {
  return new Intl.DateTimeFormat(auth.locale ?? undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}

onMounted(() => void loadSessions());
</script>

<template>
  <section>
    <div class="head">
      <div>
        <span class="micro">{{ t("nav.settings") }}</span>
        <h1>{{ t("settings.title") }}</h1>
        <p class="hint">
          {{ t("settings.subtitle") }}
        </p>
      </div>
    </div>

    <p
      v-if="notice"
      class="notice"
      role="status"
      aria-live="polite"
    >
      {{ notice }}
    </p>
    <p
      v-if="error"
      class="error"
      role="alert"
    >
      {{ error }}
    </p>

    <div class="card">
      <h2>{{ t("settings.security") }}</h2>

      <div
        v-if="recoveryCodes.length"
        class="recovery"
      >
        <p class="hint">
          {{ t("settings.recoveryHint") }}
        </p>
        <ul class="codes">
          <li
            v-for="c in recoveryCodes"
            :key="c"
          >
            <code>{{ c }}</code>
          </li>
        </ul>
      </div>

      <template v-if="!enrolling">
        <label>
          {{ t("settings.currentPassword") }}
          <input
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
          >
        </label>
        <div class="actions">
          <button
            type="button"
            :disabled="!currentPassword || busy"
            @click="startEnroll"
          >
            {{ t("settings.enableMfa") }}
          </button>
          <button
            type="button"
            class="btn-ghost"
            :disabled="!currentPassword || busy"
            @click="regenerate"
          >
            {{ t("settings.regenerateCodes") }}
          </button>
          <button
            type="button"
            class="btn-ghost danger"
            :disabled="!currentPassword || busy"
            @click="disableMfa"
          >
            {{ t("settings.disableMfa") }}
          </button>
        </div>
      </template>

      <template v-else>
        <p class="hint">
          {{ t("settings.enrollHint") }}
        </p>
        <input
          :value="enrollUri"
          readonly
          :aria-label="t('settings.otpauthUri')"
        >
        <label>
          {{ t("settings.code") }}
          <input
            v-model="enrollCode"
            autocomplete="one-time-code"
            inputmode="numeric"
          >
        </label>
        <div class="actions">
          <button
            type="button"
            :disabled="!enrollCode.trim() || busy"
            @click="confirmEnroll"
          >
            {{ t("settings.confirm") }}
          </button>
          <button
            type="button"
            class="btn-ghost"
            @click="enrolling = false"
          >
            {{ t("settings.cancel") }}
          </button>
        </div>
        <p class="hint secret">
          {{ t("settings.secretLabel") }}: <code>{{ enrollSecret }}</code>
        </p>
      </template>
    </div>

    <div class="card">
      <h2>{{ t("settings.sessions") }}</h2>
      <ul
        v-if="sessions.length"
        class="session-list"
      >
        <li
          v-for="s in sessions"
          :key="s.id"
        >
          <span class="micro">{{ s.id.slice(0, 8) }}</span>
          <time :datetime="s.createdAt">{{ fmt(s.createdAt) }}</time>
        </li>
      </ul>
      <p
        v-else
        class="hint"
      >
        {{ t("settings.noSessions") }}
      </p>
    </div>
  </section>
</template>

<style scoped>
.head {
  margin-bottom: var(--space-6);
}
.hint {
  color: var(--text-muted);
}
.notice {
  color: var(--status-success);
}
.error {
  color: var(--status-danger);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
label {
  display: grid;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: 13px;
  margin-top: var(--space-3);
}
.codes {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--space-2);
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
}
.codes code,
.secret code {
  font-family: var(--font-mono);
  font-size: 13px;
}
.session-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.session-list li {
  display: flex;
  align-items: baseline;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: var(--border-hairline);
}
.session-list time {
  margin-left: auto;
  color: var(--text-muted);
}
.danger {
  color: var(--status-danger);
}
</style>
