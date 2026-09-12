<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";
import { type AuditEventView } from "../lib/api";

const t = useTranslator();
const auth = useAuthStore();

const events = ref<AuditEventView[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const error = ref<string | null>(null);
const expanded = ref<Set<string>>(new Set());
const filters = reactive({ action: "", targetType: "" });

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat(auth.locale ?? undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
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
    const res = await api.listAudit({
      action: filters.action || undefined,
      targetType: filters.targetType || undefined,
    });
    events.value = res.data;
    nextCursor.value = res.nextCursor;
  } catch {
    error.value = t("audit.loadError");
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  const api = auth.api();
  if (!api || !nextCursor.value) return;
  loadingMore.value = true;
  try {
    const res = await api.listAudit({
      action: filters.action || undefined,
      targetType: filters.targetType || undefined,
      cursor: nextCursor.value,
    });
    events.value = [...events.value, ...res.data];
    nextCursor.value = res.nextCursor;
  } catch {
    error.value = t("audit.loadError");
  } finally {
    loadingMore.value = false;
  }
}

function toggle(id: string) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

async function clearFilters() {
  filters.action = "";
  filters.targetType = "";
  await load();
}

function metadataPairs(meta: Record<string, unknown>): [string, string][] {
  return Object.entries(meta).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]);
}

onMounted(() => void load());
</script>

<template>
  <section>
    <div class="head">
      <div>
        <span class="micro">{{ t("nav.admin") }}</span>
        <h1>{{ t("audit.title") }}</h1>
        <p class="hint">
          {{ t("audit.subtitle") }}
        </p>
      </div>
    </div>

    <div class="card filters">
      <label>
        {{ t("audit.action") }}
        <input
          v-model="filters.action"
          :placeholder="t('audit.actionPlaceholder')"
          @keyup.enter="load"
        >
      </label>
      <label>
        {{ t("audit.targetType") }}
        <input
          v-model="filters.targetType"
          :placeholder="t('audit.targetPlaceholder')"
          @keyup.enter="load"
        >
      </label>
      <button
        type="button"
        @click="load"
      >
        {{ t("audit.apply") }}
      </button>
    </div>

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

    <div
      v-else
      class="card"
    >
      <p
        v-if="!events.length"
        class="hint"
      >
        {{ filters.action || filters.targetType ? t("audit.emptyFiltered") : t("audit.empty") }}
        <button
          v-if="filters.action || filters.targetType"
          type="button"
          class="btn-ghost"
          @click="clearFilters"
        >
          {{ t("audit.clearFilters") }}
        </button>
      </p>
      <ul
        v-else
        class="audit-list"
      >
        <li
          v-for="e in events"
          :key="e.id"
        >
          <div class="audit-row">
            <span class="micro action">{{ e.action }}</span>
            <span class="hint target">{{ e.targetType ?? "—" }}<template v-if="e.targetId"> · {{ e.targetId }}</template></span>
            <time
              class="hint"
              :datetime="e.occurredAt"
            >{{ fmtDate(e.occurredAt) }}</time>
            <button
              v-if="Object.keys(e.metadata).length"
              type="button"
              class="btn-ghost"
              :aria-expanded="expanded.has(e.id)"
              @click="toggle(e.id)"
            >
              {{ expanded.has(e.id) ? t("audit.hideDetails") : t("audit.details") }}
            </button>
          </div>
          <dl
            v-if="expanded.has(e.id)"
            class="meta"
          >
            <template
              v-for="[k, v] in metadataPairs(e.metadata)"
              :key="k"
            >
              <dt>{{ k }}</dt>
              <dd>{{ v }}</dd>
            </template>
          </dl>
        </li>
      </ul>
      <button
        v-if="nextCursor"
        type="button"
        class="btn-ghost load-more"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? t("app.loading") : t("audit.loadMore") }}
      </button>
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
.error {
  color: var(--status-danger);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--space-4);
  margin-bottom: var(--space-4);
}
.filters label {
  display: grid;
  gap: var(--space-1);
  color: var(--text-secondary);
  font-size: 13px;
}
.audit-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.audit-list li {
  padding: var(--space-3) 0;
  border-bottom: var(--border-hairline);
}
.audit-row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3);
}
.audit-row .action {
  color: var(--text-primary);
}
.audit-row time {
  margin-left: auto;
}
.meta {
  display: grid;
  grid-template-columns: minmax(120px, auto) 1fr;
  gap: var(--space-1) var(--space-4);
  margin: var(--space-3) 0 0;
  font-family: var(--font-mono);
  font-size: 12px;
}
.meta dt {
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.meta dd {
  margin: 0;
  word-break: break-word;
}
.load-more {
  margin-top: var(--space-4);
}
@media (max-width: 720px) {
  .filters {
    flex-direction: column;
    align-items: stretch;
  }
  .audit-row time {
    margin-left: 0;
  }
}
</style>
