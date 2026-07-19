<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
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
const { catalogCategoryOptions, aroundLevelExerciseIds } = storeToRefs(exercisesStore)
const userProfileStore = useUserProfileStore()
const { profile } = storeToRefs(userProfileStore)
const { t } = useLocale()

type CompletionFilter = 'all' | 'completed' | 'solved' | 'failed' | 'notCompleted'
type DifficultyFilter = 'all' | 'aroundMyLevel' | 'belowMyLevel' | 'aboveMyLevel'

const searchQuery = ref('')
const completionFilter = ref<CompletionFilter>('all')
const difficultyFilter = ref<DifficultyFilter>('all')
// Opens the first category by default so the page isn't an empty list on first visit.
const expandedCategory = ref<string | null>(
  props.initialCategory ?? catalogCategoryOptions.value[0]?.value ?? null,
)

const pageEl = ref<HTMLElement | null>(null)

// When arriving with a target category (e.g. the one selected for training), bring its
// row into view — the category list can be long, and the page keeps the prior scroll.
onMounted(() => {
  if (!props.initialCategory) return
  pageEl.value?.querySelector('.category-row.selected')?.scrollIntoView({ block: 'start' })
})

// Below/above mirror the settings page's too-easy/too-hard split: everything outside the
// "around my level" pool, on either side of the user's elo.
function matchesDifficultyFilter(exercise: Exercise): boolean {
  if (difficultyFilter.value === 'all') return true
  const isAroundLevel = aroundLevelExerciseIds.value.has(exercise.id)
  if (difficultyFilter.value === 'aroundMyLevel') return isAroundLevel
  if (isAroundLevel) return false
  const userElo = profile.value?.endgameElo ?? 1400
  const exerciseElo = parseInt(exercise.difficulty)
  return difficultyFilter.value === 'belowMyLevel' ? exerciseElo < userElo : exerciseElo > userElo
}

// "Completed" means attempted (solved or failed) within the same recent-attempt window
// as the check/cross icons on the puzzle cards, so the filter and the icons always agree.
function matchesCompletionFilter(exercise: Exercise): boolean {
  if (completionFilter.value === 'all') return true
  const status = attemptStatus(exercise)
  switch (completionFilter.value) {
    case 'completed':
      return status !== null
    case 'notCompleted':
      return status === null
    default:
      return status === completionFilter.value
  }
}

function matchesFilters(exercise: Exercise): boolean {
  return matchesCompletionFilter(exercise) && matchesDifficultyFilter(exercise)
}

// Category list rebuilt from only the puzzles passing the filters, so counts reflect the
// filtered pool and categories without a single matching puzzle disappear.
const filteredCategoryOptions = computed(() =>
  exercisesStore.catalogCategoryOptionsMatching(matchesFilters),
)

// Words separated by whitespace are combined with AND, matched against the category's
// full path (not just its own label) — e.g. "rook knight" matches "Knight+Rook vs Rook"
// wherever those words fall in the category hierarchy, but not "Knight + Bishop vs King".
const filteredOptions = computed(() => {
  const terms = searchQuery.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return filteredCategoryOptions.value
  return filteredCategoryOptions.value.filter((opt) => {
    const haystack = opt.value.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
})

function toggleCategory(value: string): void {
  expandedCategory.value = expandedCategory.value === value ? null : value
}

const expandedPuzzles = computed((): Exercise[] =>
  expandedCategory.value
    ? exercisesStore.puzzlesInCategory(expandedCategory.value).filter(matchesFilters)
    : [],
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

const completionFilterOptions = computed((): { value: CompletionFilter; label: string }[] => [
  { value: 'all', label: t((s) => s.profile.browseFilterShowAll) },
  { value: 'completed', label: t((s) => s.profile.browseFilterOnlyCompleted) },
  { value: 'solved', label: t((s) => s.profile.browseFilterOnlySolved) },
  { value: 'failed', label: t((s) => s.profile.browseFilterOnlyFailed) },
  { value: 'notCompleted', label: t((s) => s.profile.browseFilterOnlyNotCompleted) },
])

const difficultyFilterOptions = computed((): { value: DifficultyFilter; label: string }[] => [
  { value: 'all', label: t((s) => s.profile.browseFilterShowAll) },
  { value: 'aroundMyLevel', label: t((s) => s.profile.browseFilterOnlyAroundMyLevel) },
  { value: 'belowMyLevel', label: t((s) => s.profile.browseFilterOnlyBelowMyLevel) },
  { value: 'aboveMyLevel', label: t((s) => s.profile.browseFilterOnlyAboveMyLevel) },
])
</script>

<template>
  <div ref="pageEl" class="browse-page">
    <input
      v-model="searchQuery"
      type="search"
      class="search-input"
      :placeholder="t((s) => s.profile.searchCategoriesPlaceholder)"
    />

    <div class="filter-bar">
      <label class="filter-field">
        <span class="filter-label">{{ t((s) => s.profile.browseFilterCompletionLabel) }}</span>
        <select v-model="completionFilter" class="filter-select">
          <option
            v-for="option in completionFilterOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>
      <label class="filter-field">
        <span class="filter-label">{{ t((s) => s.profile.browseFilterDifficultyLabel) }}</span>
        <select v-model="difficultyFilter" class="filter-select">
          <option
            v-for="option in difficultyFilterOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </label>
    </div>

    <p v-if="filteredOptions.length === 0" class="empty">
      {{
        searchQuery.trim()
          ? t((s) => s.profile.noCategoriesMatchSearch)
          : t((s) => s.profile.noCategoriesMatchFilters)
      }}
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

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem 1.25rem;
}

.filter-field {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
}

.filter-label {
  color: var(--muted);
}

.filter-select {
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.85rem;
  outline: none;
  cursor: pointer;
  transition: border-color 0.15s;
}

.filter-select:focus {
  border-color: var(--accent);
}

/* When the fields would wrap onto separate lines, align the selects in a shared
   column instead of letting each start after its differently-sized label. Must come
   after the base .filter-field/.filter-select rules to win the cascade. */
@media (max-width: 560px) {
  .filter-bar {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 0.5rem 0.75rem;
  }

  .filter-field {
    display: contents;
  }

  .filter-label {
    align-self: center;
  }

  .filter-select {
    width: 100%;
    min-width: 0;
  }
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
  /* Breathing room above the row when it's scrolled to as the initial category. */
  scroll-margin-top: 0.75rem;
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
