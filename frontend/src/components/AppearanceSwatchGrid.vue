<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useUserProfileStore } from '@/stores/userProfile'
import {
  BOARD_THEME_IDS,
  PIECE_SET_IDS,
  appearanceDisplayName,
  boardImageUrl,
  boardThemeOrDefault,
  pieceImageUrl,
  pieceSetOrDefault,
  type BoardThemeId,
  type PieceCode,
  type PieceSetId,
} from '@/utils/boardAppearance'

const props = defineProps<{ kind: 'board' | 'pieces' }>()

const userProfileStore = useUserProfileStore()
const { profile } = storeToRefs(userProfileStore)

function boardImageCss(id: BoardThemeId): string {
  return `url('${boardImageUrl(id)}')`
}

// Piece previews sit on the board the user has actually chosen, so the pair is judged
// the way it will look in play rather than against a neutral backdrop.
const selectedBoardImageCss = computed(() =>
  boardImageCss(boardThemeOrDefault(profile.value?.boardTheme)),
)

// One per square of the 2×2 preview: the two shapes that differ most between sets lead,
// and the black queen sits on a dark square so both colours are seen where they are
// hardest to read.
const PREVIEW_PIECE_CODES: PieceCode[] = ['wK', 'wN', 'bQ', 'wP']

interface SwatchOption {
  id: BoardThemeId | PieceSetId
  backgroundImage: string
  pieceImageSources: string[]
  isSelected: boolean
  // Carried per option rather than switched on `kind` at click time, so each id keeps
  // its own type all the way to the store instead of needing a cast back.
  apply: () => void
}

const options = computed((): SwatchOption[] => {
  if (props.kind === 'board') {
    const selected = boardThemeOrDefault(profile.value?.boardTheme)
    return BOARD_THEME_IDS.map((id) => ({
      id,
      backgroundImage: boardImageCss(id),
      pieceImageSources: [],
      isSelected: id === selected,
      apply: () => userProfileStore.setBoardTheme(id),
    }))
  }
  const selected = pieceSetOrDefault(profile.value?.pieceSet)
  return PIECE_SET_IDS.map((id) => ({
    id,
    backgroundImage: selectedBoardImageCss.value,
    pieceImageSources: PREVIEW_PIECE_CODES.map((code) => pieceImageUrl(id, code)),
    isSelected: id === selected,
    apply: () => userProfileStore.setPieceSet(id),
  }))
})
</script>

<template>
  <div class="swatch-grid">
    <button
      v-for="option in options"
      :key="option.id"
      type="button"
      class="swatch"
      :class="{ selected: option.isSelected }"
      :aria-pressed="option.isSelected"
      :title="appearanceDisplayName(option.id)"
      @click="option.apply()"
    >
      <span class="swatch-preview" :style="{ backgroundImage: option.backgroundImage }">
        <img
          v-for="source in option.pieceImageSources"
          :key="source"
          class="swatch-piece"
          :src="source"
          alt=""
        />
      </span>
      <span class="swatch-name">{{ appearanceDisplayName(option.id) }}</span>
    </button>
  </div>
</template>

<style scoped>
.swatch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--swatch-min-width, 72px), 1fr));
  gap: 0.5rem;
}

.swatch {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.25rem;
  padding: 0.25rem;
  background: none;
  border: 2px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  color: var(--muted);
  transition:
    border-color 0.12s,
    color 0.12s;
}

.swatch:hover {
  border-color: var(--border);
  color: var(--fg);
}

.swatch.selected {
  border-color: var(--accent, #dca200);
  color: var(--fg);
}

/* The board images are whole 8×8 boards, so a 400% background shows exactly the
   top-left 2×2 squares — enough to read both square colours and the texture. */
.swatch-preview {
  position: relative;
  display: flex;
  flex-wrap: wrap;
  aspect-ratio: 1;
  border-radius: 4px;
  overflow: hidden;
  background-size: 400% 400%;
  background-position: top left;
}

/* Exactly one piece per square of the 2×2 preview. */
.swatch-piece {
  width: 50%;
  height: 50%;
  object-fit: contain;
}

.swatch-name {
  font-size: 0.7rem;
  font-weight: 600;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
