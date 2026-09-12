<script setup lang="ts">
import { onMounted } from "vue";
import { useQuotaStore } from "../stores/quota";
import { useAuthStore } from "../stores/auth";
import { useTranslator } from "../lib/i18n";

const t = useTranslator();
const quota = useQuotaStore();
const auth = useAuthStore();

onMounted(() => {
  void quota.refreshAll();
});
</script>

<template>
  <section>
    <span class="micro">{{ t("nav.admin") }}</span>
    <h1>{{ t("nav.admin") }}</h1>

    <div
      v-if="!auth.isAdmin"
      class="card"
    >
      {{ t("errors.unauthorized") }}
    </div>
    <div
      v-else
      class="card"
    >
      <span class="micro">{{ t("admin.users") }}</span>
      <p>Connections: {{ quota.connections.length }}</p>
      <p class="hint">
        <RouterLink to="/admin/users">
          {{ t("users.title") }}
        </RouterLink>
      </p>
    </div>
  </section>
</template>

<style scoped>
.hint {
  color: var(--text-muted);
}
</style>
