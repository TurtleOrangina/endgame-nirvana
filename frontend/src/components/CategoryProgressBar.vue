<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  solved: number
  failed: number
  unattempted: number
  total: number
}>()

const attempted = computed((): number => props.solved + props.failed)
</script>

<template>
  <div class="node-bar-track">
    <div v-if="solved > 0" class="node-bar-seg solved" :style="{ flexGrow: solved }" />
    <div v-if="failed > 0" class="node-bar-seg failed" :style="{ flexGrow: failed }" />
    <div
      v-if="unattempted > 0"
      class="node-bar-seg unattempted"
      :style="{ flexGrow: unattempted }"
    />
  </div>
  <span class="node-progress-attempted">{{ attempted }}</span>
  <span class="node-progress-slash">/</span>
  <span class="node-progress-total">{{ total }}</span>
</template>

<style scoped>
.node-bar-track {
  display: flex;
  width: 100%;
  height: 7px;
  background: var(--track-bg);
  border-radius: 4px;
  overflow: hidden;
}

.node-bar-seg {
  flex-basis: 0;
  min-width: 0;
  height: 100%;
}

.node-bar-seg.solved {
  background: var(--color-solved);
}

.node-bar-seg.failed {
  background: var(--color-failed);
}

.node-bar-seg.unattempted {
  background: var(--track-bg);
}

.node-progress-attempted,
.node-progress-slash,
.node-progress-total {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.node-progress-attempted {
  text-align: right;
}

/* The slash sits in its own grid column, so the grid gap spaces it evenly on both sides. */
.node-progress-slash {
  margin: 0 -0.2rem;
}

.node-progress-total {
  text-align: left;
}
</style>
