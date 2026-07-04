<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { Color } from '@lichess-org/chessground/types'

const props = defineProps<{ fen: string }>()

const boardEl = ref<HTMLElement | null>(null)
let cg: Api | null = null

function boardFen(fen: string): string {
  return fen.split(' ')[0] ?? fen
}

function orientation(fen: string): Color {
  return (fen.split(' ')[1] ?? 'w') === 'w' ? 'white' : 'black'
}

function setup(fen: string): void {
  if (!boardEl.value) return
  if (cg) {
    cg.set({ fen: boardFen(fen), orientation: orientation(fen) })
  } else {
    cg = Chessground(boardEl.value, {
      fen: boardFen(fen),
      orientation: orientation(fen),
      viewOnly: true,
      coordinates: false,
      animation: { enabled: false },
      drawable: { enabled: false, visible: false },
      highlight: { lastMove: false, check: false },
    })
  }
}

onMounted(() => setup(props.fen))
watch(() => props.fen, setup)
onUnmounted(() => {
  cg?.destroy()
  cg = null
})
</script>

<template>
  <div class="mini-board-wrap">
    <div ref="boardEl" class="cg-wrap" />
  </div>
</template>

<style scoped>
.mini-board-wrap {
  width: 100%;
  aspect-ratio: 1;
  position: relative;
}

.cg-wrap {
  position: absolute;
  inset: 0;
}
</style>
