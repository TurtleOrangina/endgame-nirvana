<script setup lang="ts">
import { computed } from 'vue'
import { useLocale } from '@/composables/useLocale'

const props = defineProps<{
  displayMovesSinceZero: number
  pinnedTooltip: 'zero' | null
}>()

const emit = defineEmits<{
  'toggle-tooltip': [which: 'zero']
}>()

const { t } = useLocale()

// The 50-move rule draws at 50 moves since the last pawn push/capture — fill
// the ring proportionally towards that threshold rather than resetting it each move.
const RING_CIRCUMFERENCE = 81.68
const DRAW_THRESHOLD_MOVES = 50

const ringDashoffset = computed(() => {
  const fraction = Math.min(props.displayMovesSinceZero / DRAW_THRESHOLD_MOVES, 1)
  return RING_CIRCUMFERENCE * (1 - fraction)
})
</script>

<template>
  <div class="move-counters">
    <div class="counter-bubble zero-count-bubble" @click.stop="emit('toggle-tooltip', 'zero')">
      <svg class="counter-ring" viewBox="0 0 32 32" fill="none">
        <circle class="ring-track zero-count-track" cx="16" cy="16" r="13" />
        <circle
          class="ring-sweep zero-count-sweep"
          cx="16"
          cy="16"
          r="13"
          :style="{ strokeDashoffset: ringDashoffset }"
        />
      </svg>
      <span class="counter-number">{{ displayMovesSinceZero }}</span>
      <div
        class="tooltip"
        :class="{ pinned: pinnedTooltip === 'zero' }"
        @click.stop="emit('toggle-tooltip', 'zero')"
      >
        {{ t((s) => s.moveCounter.movesSinceZeroTooltip) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.move-counters {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.counter-bubble {
  position: relative;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  border: 1px solid var(--border);
  cursor: pointer;
}

.counter-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}

.ring-track {
  fill: none;
  stroke-width: 2.5;
}

.ring-sweep {
  fill: none;
  stroke-width: 2.5;
  stroke-dasharray: 81.68;
  transition: stroke-dashoffset 0.4s ease-out;
}

.zero-count-track {
  stroke: rgba(224, 123, 57, 0.2);
}

.zero-count-sweep {
  stroke: #e07b39;
}

.counter-number {
  position: relative;
  font-size: 0.8rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  z-index: 1;
  line-height: 1;
}

.tooltip {
  position: absolute;
  right: 50%;
  top: calc(100% + 0.5rem);
  transform: translateX(50%);
  background: var(--fg);
  color: var(--bg);
  padding: 0.4rem 0.65rem;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 500;
  line-height: 1.4;
  width: max-content;
  max-width: 220px;
  text-align: center;
  white-space: normal;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s;
  z-index: 200;
}

.counter-bubble:hover .tooltip,
.tooltip.pinned {
  opacity: 1;
  pointer-events: auto;
}
</style>
