<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useExercisesStore, type Exercise } from '@/stores/exercises'
import { useUserProfileStore } from '@/stores/userProfile'
import { useLocale } from '@/composables/useLocale'
import { puzzleDifficultyBand } from '@/utils/puzzleDifficultyColor'
import MiniBoard from '@/components/MiniBoard.vue'
import CategorySolveCount from '@/components/CategorySolveCount.vue'

const props = defineProps<{
  initialCategory?: string | null
}>()

const emit = defineEmits<{
  'load-puzzle': [payload: { exerciseId: string; transformCode: string }]
}>()

const exercisesStore = useExercisesStore()
const { catalogCategoryOptions } = storeToRefs(exercisesStore)
const userProfileStore = useUserProfileStore()
const { profile } = storeToRefs(userProfileStore)
const { t } = useLocale()

const searchQuery = ref('')
// Opens the first category by default so the page isn't an empty list on first visit.
const expandedCategory = ref<string | null>(
  props.initialCategory ?? catalogCategoryOptions.value[0]?.value ?? null,
)

// Words separated by whitespace are combined with AND, matched against the category's
// full path (not just its own label) — e.g. "rook knight" matches "Knight+Rook vs Rook"
// wherever those words fall in the category hierarchy, but not "Knight + Bishop vs King".
const filteredOptions = computed(() => {
  const terms = searchQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return catalogCategoryOptions.value
  return catalogCategoryOptions.value.filter((opt) => {
    const haystack = opt.value.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
})

function toggleCategory(value: string): void {
  expandedCategory.value = expandedCategory.value === value ? null : value
}

const expandedPuzzles = computed((): Exercise[] =>
  expandedCategory.value ? exercisesStore.puzzlesInCategory(expandedCategory.value) : [],
)

function eloBandClass(exercise: Exercise): string {
  return puzzleDifficultyBand(parseInt(exercise.difficulty), profile.value?.endgameElo ?? 1400)
}

function attemptStatus(exercise: Exercise): 'solved' | 'failed' | null {
  return exercisesStore.recentAttemptStatus(exercise.id)
}

function onPuzzleClick(exercise: Exercise): void {
  emit('load-puzzle', { exerciseId: exercise.id, transformCode: '' })
}
</script>

<template>
  <div class="browse-page">
    <input
      v-model="searchQuery"
      type="search"
      class="search-input"
      :placeholder="t((s) => s.profile.searchCategoriesPlaceholder)"
    />

    <p v-if="filteredOptions.length === 0" class="empty">
      {{ t((s) => s.profile.noCategoriesMatchSearch) }}
    </p>

    <div v-else class="category-list">
      <template v-for="opt in filteredOptions" :key="opt.value">
        <div
          class="category-row"
          :class="{ selected: expandedCategory === opt.value }"
          :style="{ paddingLeft: `calc(0.5rem + ${opt.depth} * 1rem)` }"
          @click="toggleCategory(opt.value)"
        >
          <span class="category-label">{{ opt.label }}</span>
          <CategorySolveCount :attempted="0" :total="opt.total" />
        </div>

        <div v-if="expandedCategory === opt.value" class="puzzle-grid">
          <div
            v-for="exercise in expandedPuzzles"
            :key="exercise.id"
            class="puzzle-card"
            @click="onPuzzleClick(exercise)"
          >
            <MiniBoard :fen="exercise.fen" />
            <div class="puzzle-meta">
              <span :class="['meta-chip', eloBandClass(exercise)]">{{ exercise.difficulty }}</span>
              <span :class="['meta-chip', exercise.expectedResult]">
                {{
                  exercise.expectedResult === 'win'
                    ? t((s) => s.app.resultWin)
                    : t((s) => s.app.resultDraw)
                }}
              </span>
              <svg
                v-if="attemptStatus(exercise) === 'solved'"
                class="attempt-icon solved"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <svg
                v-else-if="attemptStatus(exercise) === 'failed'"
                class="attempt-icon failed"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.browse-page {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.search-input {
  padding: 0.5rem 0.85rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.9rem;
  outline: none;
  transition: border-color 0.15s;
}

.search-input:focus {
  border-color: var(--accent);
}

.empty {
  font-size: 0.875rem;
  color: var(--muted);
}

.category-list {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.category-row {
  display: flex;
  align-items: center;
  padding: 0.5rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.9rem;
  transition: background 0.1s;
}

.category-row:hover {
  background: var(--hover-bg);
}

.category-row.selected {
  background: var(--badge-bg);
  font-weight: 600;
}

.category-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.puzzle-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 0.6rem;
  padding: 0.6rem 0.5rem 1rem;
}

.puzzle-card {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  cursor: pointer;
  border-radius: 4px;
  border: 1px solid var(--border);
  transition: border-color 0.15s;
}

.puzzle-card:hover {
  border-color: var(--accent);
}

.puzzle-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.3rem;
  padding: 0 0.2rem 0.3rem;
}

.meta-chip {
  padding: 0.05rem 0.35rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.meta-chip.harder {
  border-color: var(--color-failed);
  color: var(--color-failed);
}

.meta-chip.match {
  border-color: var(--color-warning-border);
  color: var(--color-warning-fg);
}

.meta-chip.easier {
  border-color: var(--color-solved);
  color: var(--color-solved);
}

.meta-chip.win {
  border-color: var(--tag-win-border);
  color: var(--tag-win-fg);
}

.meta-chip.draw {
  border-color: var(--tag-draw-border);
  color: var(--tag-draw-fg);
}

.attempt-icon {
  width: 15px;
  height: 15px;
  padding: 0.1rem;
  border-radius: 50%;
}

.attempt-icon.solved {
  color: var(--color-solved);
}

.attempt-icon.failed {
  color: var(--color-failed);
}
</style>
