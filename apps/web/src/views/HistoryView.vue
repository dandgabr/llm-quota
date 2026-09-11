<script setup lang="ts">
import { computed, onMounted } from "vue";
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

onMounted(() => {
  void quota.refreshAll();
});

// Flat + muted pastel dataviz (ADR-011): no gradients, hairline grid, mono ticks.
const chartData = computed<ChartData<"bar">>(() => ({
  labels: quota.history.map((h) => h.windowKey),
  datasets: [
    {
      label: `Spending ${quota.history[0]?.currency ?? "USD"}`,
      data: quota.history.map((h) => h.spentAmount),
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

    <div
      v-if="quota.loading"
      class="card"
    >
      {{ t("app.loading") }}
    </div>
    <div
      v-else-if="quota.history.length === 0"
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
.chart-card {
  height: 320px;
  padding: var(--space-6);
}
</style>
