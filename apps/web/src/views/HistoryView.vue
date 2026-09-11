<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Bar } from "vue-chartjs";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
  type ChartData,
  type ChartOptions,
} from "chart.js";
import { useQuotaStore } from "../stores/quota";
import { useTranslator } from "../lib/i18n";

const t = useTranslator();
const quota = useQuotaStore();

// Register only what we use (keeps the bundle lean + avoids default plugins).
ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

type Gran = "daily" | "weekly" | "monthly";
const gran = ref<Gran>("daily");

onMounted(() => {
  void quota.refreshAll();
});

/** Points for the active granularity (fallback: all points when none tagged). */
const points = computed(() => {
  if (!quota.history.length) return quota.history;
  return quota.history.filter((h) => !h.granularity || h.granularity === gran.value);
});

// Flat + muted pastel dataviz (ADR-011): no gradients, hairline grid, mono ticks.
const chartData = computed<ChartData<"bar">>(() => ({
  labels: points.value.map((h) => h.windowKey),
  datasets: [
    {
      label: `${t("history." + gran.value)} · ${points.value[0]?.currency ?? "USD"}`,
      data: points.value.map((h) => h.spentAmount),
      backgroundColor: "#C7D4E8", // sky-300 muted pastel
      borderColor: "#5C564C", // ink-700, thin hairline definition
      borderWidth: 1,
      borderRadius: 4,
    },
  ],
}));

const chartOptions: ChartOptions<"bar"> = {
  responsive: true,
  maintainAspectRatio: false,
  animation: { duration: 180, easing: "easeOutQuart" },
  scales: {
    y: { beginAtZero: true, grid: { color: "rgba(24,20,16,0.08)" } },
    x: { grid: { display: false } },
  },
  plugins: {
    legend: { labels: { color: "#5C564C", font: { family: "'JetBrains Mono', monospace" } } },
    tooltip: {
      backgroundColor: "#E4DED2",
      titleColor: "#23201B",
      bodyColor: "#23201B",
      borderColor: "rgba(24,20,16,0.18)",
      borderWidth: 1,
    },
  },
};
</script>

<template>
  <section>
    <span class="micro">{{ t("history.title") }}</span>
    <h1>{{ t("nav.history") }}</h1>

    <div class="controls">
      <button
        v-for="g in (['daily', 'weekly', 'monthly'] as Gran[])"
        :key="g"
        class="ghost"
        :class="{ active: gran === g }"
        type="button"
        @click="gran = g"
      >
        {{ t("history." + g) }}
      </button>
    </div>

    <div
      v-if="quota.loading && !quota.loaded"
      class="card chart-card skeleton"
      aria-busy="true"
    />
    <div
      v-else-if="points.length === 0"
      class="card"
    >
      No history yet.
    </div>
    <div
      v-else
      class="card chart-card"
      role="img"
      :aria-label="t('history.title')"
    >
      <Bar
        :data="chartData"
        :options="chartOptions"
      />
    </div>
  </section>
</template>

<style scoped>
.controls {
  display: flex;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.ghost {
  background: transparent;
  color: var(--text-secondary);
  border: var(--border-hairline);
  padding: var(--space-1) var(--space-3);
  box-shadow: none;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.04em;
}
.ghost:hover {
  color: var(--text-primary);
  border-color: var(--hairline-strong);
}
.ghost.active {
  color: var(--accent-on-accent);
  background: var(--accent-action);
  border-color: transparent;
}
.chart-card {
  height: 320px;
  padding: var(--space-6);
}
.skeleton {
  background: var(--surface-raised);
  animation: pulse 1.4s var(--ease-out-quart) infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.6; }
}
</style>
