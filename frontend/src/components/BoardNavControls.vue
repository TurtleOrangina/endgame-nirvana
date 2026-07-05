<script setup lang="ts">
import MoveCounters from '@/components/MoveCounters.vue'
import { useLocale } from '@/composables/useLocale'

defineProps<{
  canJumpBack: boolean
  canJumpForward: boolean
  canPlayBestMove: boolean
  isFindingBestMove: boolean
  moveCounter?: {
    displayMovesSinceZero: number
    pinnedTooltip: 'zero' | null
  }
}>()

const emit = defineEmits<{
  'jump-start': []
  'step-back': []
  'play-best-move': []
  'step-forward': []
  'jump-end': []
  'toggle-tooltip': [which: 'zero']
}>()

const { t } = useLocale()
</script>

<template>
  <div class="board-nav">
    <button
      class="nav-btn"
      :title="t((s) => s.boardNav.firstMove)"
      :disabled="!canJumpBack"
      @click="emit('jump-start')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="18 17 11 12 18 7" />
        <line x1="7" y1="6" x2="7" y2="18" />
      </svg>
    </button>

    <button
      class="nav-btn"
      :title="t((s) => s.boardNav.previousMove)"
      :disabled="!canJumpBack"
      @click="emit('step-back')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>

    <button
      class="nav-btn"
      :title="t((s) => s.boardNav.playBestMove)"
      :disabled="!canPlayBestMove || isFindingBestMove"
      @click="emit('play-best-move')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M9 18h6" />
        <path d="M10 21h4" />
        <path
          d="M12 3a6 6 0 0 0-4 10.5c.6.5 1 1.3 1 2.1V16h6v-.4c0-.8.4-1.6 1-2.1A6 6 0 0 0 12 3Z"
        />
      </svg>
    </button>

    <MoveCounters
      v-if="moveCounter"
      v-bind="moveCounter"
      @toggle-tooltip="emit('toggle-tooltip', $event)"
    />

    <button
      class="nav-btn"
      :title="t((s) => s.boardNav.nextMove)"
      :disabled="!canJumpForward"
      @click="emit('step-forward')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="9 18 15 12 9 6" />
      </svg>
    </button>

    <button
      class="nav-btn"
      :title="t((s) => s.boardNav.lastMove)"
      :disabled="!canJumpForward"
      @click="emit('jump-end')"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="6 7 13 12 6 17" />
        <line x1="17" y1="6" x2="17" y2="18" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.board-nav {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0.7rem;
}

.nav-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  cursor: pointer;
  transition:
    background 0.1s,
    color 0.1s,
    opacity 0.1s;
}

.nav-btn svg {
  width: 18px;
  height: 18px;
}

@media (max-width: 720px) {
  .board-nav {
    gap: 0.6rem;
  }

  .nav-btn {
    width: 44px;
    height: 44px;
  }

  .nav-btn svg {
    width: 21px;
    height: 21px;
  }
}

.nav-btn:hover:not(:disabled) {
  background: var(--hover-bg);
}

.nav-btn:disabled {
  opacity: 0.35;
  cursor: default;
}
</style>
