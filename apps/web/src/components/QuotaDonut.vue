<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{ percent: number; label?: string; value?: string }>(),
  { percent: 0, label: "", value: undefined },
);

/** Which status tone applies to the remaining percent. */
const tone = computed<"ok" | "warn" | "danger">(() => {
  if (props.percent >= 80) return "danger";
  if (props.percent >= 50) return "warn";
  return "ok";
});

/** SVG arc for a donut ring: full circle minus a 3px gap at the top. */
const RADIUS = 40;
const ring = computed(() => {
  const c = 2 * Math.PI * RADIUS;
  const used = Math.min(props.percent, 100) / 100;
  return { circumference: c, dash: `${c * used} ${c}` };
});
</script>

<template>
  <div
    class="donut"
    role="img"
    :aria-label="`${label}: ${value ?? `${percent}%`} used`"
  >
    <svg
      viewBox="0 0 100 100"
      class="svg"
    >
      <circle
        class="track"
        :r="40"
        cx="50"
        cy="50"
        stroke-width="8"
        fill="none"
      />
      <circle
        class="arc"
        :class="tone"
        :r="40"
        cx="50"
        cy="50"
        :stroke-dasharray="ring.dash"
        :stroke-dashoffset="ring.circumference * 0.25"
        stroke-width="8"
        fill="none"
        stroke-linecap="round"
      />
    </svg>
    <strong class="tabular numeric hero-num" :class="{ 'is-val': Boolean(value) }">
      {{ value ?? `${percent}%` }}
    </strong>
    <span class="micro caption">{{ label }}</span>
  </div>
</template>

<style scoped>
.donut {
  position: relative;
  width: 120px;
  height: 120px;
  display: grid;
  place-items: center;
}
.svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.track {
  stroke: var(--chart-fill-track);
}
.arc {
  transition: stroke-dasharray var(--transition-fast), stroke var(--transition-fast);
}
.arc.ok {
  stroke: var(--status-success);
}
.arc.warn {
  stroke: var(--status-warning);
}
.arc.danger {
  stroke: var(--status-danger);
}
.numeric {
  position: absolute;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 700;
}
.numeric.is-val {
  font-size: 16px;
}
.caption {
  position: absolute;
  bottom: -6px;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
}
</style>
