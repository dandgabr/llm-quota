<script setup lang="ts">
import { onMounted } from "vue";
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

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const quota = useQuotaStore();

onMounted(() => {
  void quota.refreshAll();
});

const chartData = (): ChartData<"bar"> => ({
  labels: quota.history.map((h) => h.windowKey),
  datasets: [
    {
      label: `Spending ${quota.history[0]?.currency ?? "USD"}`,
      data: quota.history.map((h) => h.spentAmount),
      backgroundColor: "rgba(54, 162, 235, 0.6)",
    },
  ],
});

const chartOptions: ChartOptions<"bar"> = {
  responsive: true,
  scales: { y: { beginAtZero: true } },
};
</script>

<template>
  <section>
    <h1>Spending history</h1>
    <div v-if="quota.history.length === 0 && !quota.loading">
      No history yet.
    </div>
    <div v-else-if="quota.history.length">
      <Bar
        :data="chartData()"
        :options="chartOptions"
      />
    </div>
  </section>
</template>
