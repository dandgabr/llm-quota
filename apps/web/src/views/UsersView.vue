<script setup lang="ts">
import { nextTick, onMounted, reactive, ref } from "vue";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";
import { ApiError, type InviteView, type Role, type UserView } from "../lib/api";

const t = useTranslator();
const auth = useAuthStore();
const users = ref<UserView[]>([]);
const invites = ref<InviteView[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const inviteOpen = ref(false);
const inviteForm = reactive<{ email: string; role: Role; expiresInHours: number }>({
  email: "",
  role: "user",
  expiresInHours: 72,
});
const inviteError = ref<string | null>(null);
const createdInvite = ref<{ email: string; url: string } | null>(null);
const copied = ref(false);

const roleDialog = ref<{ user: UserView; role: Role } | null>(null);
const deleteDialog = ref<{ user: UserView; confirm: string } | null>(null);
const dialogError = ref<string | null>(null);
const busy = ref(false);

/** Last focused element before opening a dialog (focus is restored on close). */
let lastFocused: HTMLElement | null = null;

function captureFocus() {
  lastFocused = (document.activeElement as HTMLElement) ?? null;
}

function restoreFocus() {
  lastFocused?.focus();
  lastFocused = null;
}

/** Focus the first focusable control inside the dialog (a11y). */
function focusFirstField(selector: string) {
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>(selector);
    el?.focus();
  });
}

function closeDialogs() {
  inviteOpen.value = false;
  createdInvite.value = null;
  roleDialog.value = null;
  deleteDialog.value = null;
  restoreFocus();
}

const roles: Role[] = ["user", "supervisor", "admin"];

function fullName(u: UserView): string {
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
  return name || u.email;
}

function roleLabel(role: Role): string {
  return t(`users.roles.${role}`);
}

async function load() {
  loading.value = true;
  error.value = null;
  const api = auth.api();
  if (!api) {
    error.value = t("errors.unauthorized");
    loading.value = false;
    return;
  }
  try {
    const [u, i] = await Promise.all([api.listUsers(), api.listInvites()]);
    users.value = u;
    invites.value = i;
  } catch (err) {
    error.value = err instanceof ApiError && err.code === "forbidden"
      ? t("errors.unauthorized")
      : t("users.loadError");
  } finally {
    loading.value = false;
  }
}

function openInvite() {
  inviteForm.email = "";
  inviteForm.role = "user";
  inviteForm.expiresInHours = 72;
  inviteError.value = null;
  createdInvite.value = null;
  copied.value = false;
  captureFocus();
  inviteOpen.value = true;
  focusFirstField('[data-dialog="invite"] input[type="email"]');
}

async function submitInvite() {
  const api = auth.api();
  if (!api) return;
  inviteError.value = null;
  if (!inviteForm.email.includes("@")) {
    inviteError.value = t("errors.invalidEmail");
    return;
  }
  busy.value = true;
  try {
    const res = await api.createInvite({
      email: inviteForm.email.trim().toLowerCase(),
      role: inviteForm.role,
      expiresInHours: inviteForm.expiresInHours,
    });
    createdInvite.value = { email: res.invite.email, url: res.inviteUrl };
    invites.value = [res.invite, ...invites.value];
  } catch (err) {
    if (err instanceof ApiError && err.code === "user-exists") inviteError.value = t("errors.userExists");
    else inviteError.value = t("errors.generic");
  } finally {
    busy.value = false;
  }
}

async function copyLink() {
  if (!createdInvite.value) return;
  try {
    await navigator.clipboard.writeText(createdInvite.value.url);
    copied.value = true;
    notice.value = t("invites.copied");
  } catch {
    // clipboard blocked; the link stays visible for manual copy
  }
}

function openRole(user: UserView) {
  dialogError.value = null;
  captureFocus();
  roleDialog.value = { user, role: user.role };
  focusFirstField('[data-dialog="role"] select');
}

async function confirmRole() {
  if (!roleDialog.value) return;
  const api = auth.api();
  if (!api) return;
  busy.value = true;
  dialogError.value = null;
  try {
    const updated = await api.updateUser(roleDialog.value.user.id, { role: roleDialog.value.role });
    users.value = users.value.map((u) => (u.id === updated.id ? updated : u));
    notice.value = t("users.roleUpdated");
    closeDialogs();
  } catch (err) {
    dialogError.value = err instanceof ApiError && err.code === "last-admin"
      ? t("users.lastAdminGuard")
      : err instanceof ApiError && err.code === "conflict"
        ? t("users.selfGuard")
        : t("errors.generic");
  } finally {
    busy.value = false;
  }
}

async function toggleBlock(user: UserView) {
  const api = auth.api();
  if (!api) return;
  notice.value = null;
  error.value = null;
  try {
    const updated = await api.updateUser(user.id, { isActive: !user.isActive });
    users.value = users.value.map((u) => (u.id === updated.id ? updated : u));
    notice.value = user.isActive ? t("users.blockedDone") : t("users.unblockedDone");
  } catch (err) {
    // Failures must be announced as errors, never as success.
    error.value = err instanceof ApiError && err.code === "conflict"
      ? t("users.selfGuard")
      : t("errors.generic");
  }
}

function openDelete(user: UserView) {
  dialogError.value = null;
  captureFocus();
  deleteDialog.value = { user, confirm: "" };
  focusFirstField('[data-dialog="delete"] input');
}

async function confirmDelete() {
  if (!deleteDialog.value) return;
  const api = auth.api();
  if (!api) return;
  busy.value = true;
  dialogError.value = null;
  try {
    await api.deleteUser(deleteDialog.value.user.id);
    users.value = users.value.filter((u) => u.id !== deleteDialog.value?.user.id);
    notice.value = t("users.deleted");
    closeDialogs();
  } catch (err) {
    dialogError.value = err instanceof ApiError && err.code === "last-admin"
      ? t("users.lastAdminGuard")
      : t("errors.generic");
  } finally {
    busy.value = false;
  }
}

async function revokeInvite(invite: InviteView) {
  const api = auth.api();
  if (!api) return;
  notice.value = null;
  error.value = null;
  try {
    await api.revokeInvite(invite.id);
    invites.value = invites.value.filter((i) => i.id !== invite.id);
    notice.value = t("invites.revoked");
  } catch {
    error.value = t("errors.generic");
  }
}

function formatDate(iso: string): string {
  const locale = auth.locale ?? undefined;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="head">
      <div>
        <span class="micro">{{ t("nav.admin") }}</span>
        <h1>{{ t("users.title") }}</h1>
        <p class="hint">
          {{ t("users.subtitle") }}
        </p>
      </div>
      <button
        type="button"
        :disabled="!auth.isAdmin"
        @click="openInvite"
      >
        {{ t("users.invite") }}
      </button>
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

    <div
      v-if="loading"
      class="card skeleton"
      style="min-height: 120px"
      aria-busy="true"
      :aria-label="t('app.loading')"
    />

    <template v-else>
      <div class="card">
        <h2>{{ t("admin.users") }}</h2>
        <p
          v-if="!users.length"
          class="hint"
        >
          {{ t("users.empty") }}
          <button
            type="button"
            class="btn-ghost"
            :disabled="!auth.isAdmin"
            @click="openInvite"
          >
            {{ t("users.emptyCta") }}
          </button>
        </p>
        <table
          v-else
          class="users-table"
        >
          <thead>
            <tr>
              <th scope="col">
                {{ t("users.email") }}
              </th>
              <th scope="col">
                {{ t("users.name") }}
              </th>
              <th scope="col">
                {{ t("users.role") }}
              </th>
              <th scope="col">
                {{ t("users.status") }}
              </th>
              <th scope="col">
                {{ t("users.actions") }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="u in users"
              :key="u.id"
            >
              <td :data-label="t('users.email')">
                {{ u.email }}
              </td>
              <td :data-label="t('users.name')">
                {{ fullName(u) }}
              </td>
              <td :data-label="t('users.role')">
                {{ roleLabel(u.role) }}
              </td>
              <td :data-label="t('users.status')">
                <span :class="['tag', u.isActive ? 'is-ok' : 'is-blocked']">
                  {{ u.isActive ? t("users.active") : t("users.blocked") }}
                </span>
              </td>
              <td
                class="row-actions"
                :data-label="t('users.actions')"
              >
                <button
                  type="button"
                  class="btn-ghost"
                  @click="openRole(u)"
                >
                  {{ t("users.changeRole") }}
                </button>
                <button
                  type="button"
                  class="btn-ghost"
                  @click="toggleBlock(u)"
                >
                  {{ u.isActive ? t("users.block") : t("users.unblock") }}
                </button>
                <button
                  type="button"
                  class="btn-ghost danger"
                  @click="openDelete(u)"
                >
                  {{ t("users.delete") }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>{{ t("invites.title") }}</h2>
        <p
          v-if="!invites.length"
          class="hint"
        >
          {{ t("invites.empty") }}
        </p>
        <ul
          v-else
          class="invite-list"
        >
          <li
            v-for="i in invites"
            :key="i.id"
          >
            <span>{{ i.email }}</span>
            <span class="micro">{{ roleLabel(i.role) }}</span>
            <span class="micro">{{ t("invites.expiresAt", { date: formatDate(i.expiresAt) }) }}</span>
            <button
              type="button"
              class="btn-ghost"
              @click="revokeInvite(i)"
            >
              {{ t("invites.revoke") }}
            </button>
          </li>
        </ul>
      </div>
    </template>

    <!-- Invite dialog -->
    <div
      v-if="inviteOpen"
      class="overlay"
      data-dialog="invite"
      role="dialog"
      aria-modal="true"
      aria-labelledby="invite-title"
      @keydown.esc="closeDialogs"
    >
      <div class="modal card is-raised">
        <h2 id="invite-title">
          {{ t("users.invite") }}
        </h2>
        <template v-if="!createdInvite">
          <form @submit.prevent="submitInvite">
            <label>
              {{ t("users.email") }}
              <input
                v-model="inviteForm.email"
                type="email"
                autocomplete="off"
                required
              >
            </label>
            <label>
              {{ t("invites.role") }}
              <select v-model="inviteForm.role">
                <option
                  v-for="r in roles"
                  :key="r"
                  :value="r"
                >
                  {{ roleLabel(r) }}
                </option>
              </select>
            </label>
            <p
              v-if="inviteError"
              class="error"
              role="alert"
            >
              {{ inviteError }}
            </p>
            <div class="modal-actions">
              <button
                type="button"
                class="btn-ghost"
                :aria-label="t('users.close')"
                @click="closeDialogs"
              >
                ✕
              </button>
              <button
                type="submit"
                :disabled="busy"
              >
                {{ t("users.invite") }}
              </button>
            </div>
          </form>
        </template>
        <template v-else>
          <p>{{ t("invites.createdFor", { email: createdInvite.email }) }}</p>
          <p class="hint">
            {{ t("invites.sendHint") }}
          </p>
          <input
            :value="createdInvite.url"
            readonly
            :aria-label="t('invites.linkLabel')"
          >
          <div class="modal-actions">
            <button
              type="button"
              class="btn-ghost"
              :aria-label="t('users.close')"
              @click="closeDialogs"
            >
              ✕
            </button>
            <button
              type="button"
              @click="copyLink"
            >
              {{ copied ? t("invites.copied") : t("invites.copyLink") }}
            </button>
          </div>
        </template>
      </div>
    </div>

    <!-- Role dialog -->
    <div
      v-if="roleDialog"
      class="overlay"
      data-dialog="role"
      role="dialog"
      aria-modal="true"
      aria-labelledby="role-title"
      @keydown.esc="closeDialogs"
    >
      <div class="modal card is-raised">
        <h2 id="role-title">
          {{ t("users.changeRoleTitle", { name: fullName(roleDialog.user) }) }}
        </h2>
        <p class="hint">
          {{ t("users.changeRoleImpact", { name: fullName(roleDialog.user) }) }}
        </p>
        <label>
          {{ t("users.role") }}
          <select v-model="roleDialog.role">
            <option
              v-for="r in roles"
              :key="r"
              :value="r"
            >
              {{ roleLabel(r) }}
            </option>
          </select>
        </label>
        <p
          v-if="dialogError"
          class="error"
          role="alert"
        >
          {{ dialogError }}
        </p>
        <div class="modal-actions">
          <button
            type="button"
            class="btn-ghost"
            :aria-label="t('users.close')"
            @click="closeDialogs"
          >
            ✕
          </button>
          <button
            type="button"
            :disabled="busy"
            @click="confirmRole"
          >
            {{ t("users.changeRole") }}
          </button>
        </div>
      </div>
    </div>

    <!-- Delete dialog -->
    <div
      v-if="deleteDialog"
      class="overlay"
      data-dialog="delete"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-title"
      @keydown.esc="closeDialogs"
    >
      <div class="modal card is-raised">
        <h2 id="delete-title">
          {{ t("users.deleteTitle", { name: fullName(deleteDialog.user) }) }}
        </h2>
        <p class="hint">
          {{ t("users.deleteWarning") }}
        </p>
        <label>
          {{ t("users.deleteConfirmLabel") }}
          <input v-model="deleteDialog.confirm">
        </label>
        <p
          v-if="dialogError"
          class="error"
          role="alert"
        >
          {{ dialogError }}
        </p>
        <div class="modal-actions">
          <button
            type="button"
            class="btn-ghost"
            :aria-label="t('users.close')"
            @click="closeDialogs"
          >
            ✕
          </button>
          <button
            type="button"
            class="danger-solid"
            :disabled="busy || deleteDialog.confirm.toLowerCase() !== deleteDialog.user.email.toLowerCase()"
            @click="confirmDelete"
          >
            {{ t("users.delete") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
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
.users-table {
  width: 100%;
  border-collapse: collapse;
}
.users-table th,
.users-table td {
  text-align: left;
  padding: var(--space-3) var(--space-2);
  border-bottom: var(--border-hairline);
}
.users-table th {
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.09em;
}
.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}
.invite-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.invite-list li {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: var(--border-hairline);
}
.invite-list li button {
  margin-left: auto;
}
.overlay {
  position: fixed;
  inset: 0;
  background: var(--scrim);
  display: grid;
  place-items: center;
  padding: var(--space-4);
}
.modal {
  width: min(480px, 100%);
  max-height: 90vh;
  overflow: auto;
}
.modal form {
  display: grid;
  gap: var(--space-4);
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-4);
}
.danger {
  color: var(--status-danger);
}
.danger-solid {
  background: var(--status-danger);
  color: var(--accent-on-accent);
}
@media (max-width: 720px) {
  .users-table thead {
    display: none;
  }
  .users-table tr {
    display: block;
    padding: var(--space-3) 0;
    border-bottom: var(--border-hairline);
  }
  .users-table td {
    display: flex;
    gap: var(--space-2);
    border: none;
    padding: 2px 0;
  }
  .users-table td::before {
    content: attr(data-label);
    flex: 0 0 40%;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .row-actions {
    margin-top: var(--space-2);
  }
}
</style>
