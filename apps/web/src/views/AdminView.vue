<script setup lang="ts">
import { onMounted } from "vue";
import { useQuotaStore } from "../stores/quota";
import { useAuthStore } from "../stores/auth";

const quota = useQuotaStore();
const auth = useAuthStore();
void auth;
onMounted(() => {
  void quota.refreshAll();
});
</script>

<template>
  <section>
    <h1>Administration</h1>
    <p v-if="!auth.isAdmin">
      Admin role required to view this page.
    </p>
    <p v-else>
      Connection count: {{ quota.connections.length }} · Users/identity providers land with the admin API.
    </p>
  </section>
</template>
