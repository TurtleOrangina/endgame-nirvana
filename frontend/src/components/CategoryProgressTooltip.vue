<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '@/composables/useLocale'

const props = defineProps<{
  label: string
  solved: number
  failed: number
  unattempted: number
  total: number
  hidden: number
}>()

const { t } = useLocale()

function asPercentLabel(fraction: number): string {
  return t((s) => s.profile.progressTooltip.percentValue, {
    percent: Math.round(fraction * 100),
  })
}

const attempted = computed((): number => props.solved + props.failed)
const solveRate = computed((): string =>
  asPercentLabel(attempted.value > 0 ? props.solved / attempted.value : 0),
)
const completionRate = computed((): string =>
  asPercentLabel(props.total > 0 ? props.solved / props.total : 0),
)
</script>

<template>
  <div class="progress-tooltip" role="tooltip">
    <div class="tooltip-title">{{ label }}</div>
    <div class="tooltip-rows">
      <span class="row-label">{{ t((s) => s.profile.progressTooltip.solved) }}</span>
      <span class="row-value solved">{{ solved }}</span>
      <span class="row-label">{{ t((s) => s.profile.progressTooltip.failed) }}</span>
      <span class="row-value failed">{{ failed }}</span>
      <span class="row-label">{{ t((s) => s.profile.progressTooltip.remaining) }}</span>
      <span class="row-value">{{ unattempted }}</span>
      <template v-if="hidden > 0">
        <span class="row-label">{{ t((s) => s.profile.progressTooltip.hiddenForLevel) }}</span>
        <span class="row-value hidden-count">{{ hidden }}</span>
      </template>
      <span class="row-label">{{ t((s) => s.profile.progressTooltip.solveRate) }}</span>
      <span class="row-value">{{ solveRate }}</span>
      <span class="row-label">{{ t((s) => s.profile.progressTooltip.completionRate) }}</span>
      <span class="row-value">{{ completionRate }}</span>
    </div>
  </div>
</template>

<style scoped>
.progress-tooltip {
  position: absolute;
  top: calc(100% + 4px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 20;
  width: max-content;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
  font-size: 0.8rem;
  font-weight: 400;
  color: var(--fg);
  text-align: left;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 0.1s ease;
}

.tooltip-title {
  text-align: center;
  font-weight: 700;
  padding-bottom: 0.35rem;
  margin-bottom: 0.35rem;
  border-bottom: 1px solid var(--border);
}

.tooltip-rows {
  display: grid;
  grid-template-columns: auto auto;
  column-gap: 1rem;
  row-gap: 0.15rem;
}

.row-label {
  color: var(--muted);
}

.row-value {
  text-align: right;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.row-value.solved {
  color: var(--color-solved);
}

.row-value.failed {
  color: var(--color-failed);
}

.row-value.hidden-count {
  color: var(--muted);
}
</style>
