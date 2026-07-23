<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useExercisesStore } from '@/stores/exercises'
import { useUserProfileStore } from '@/stores/userProfile'
import { useLocale } from '@/composables/useLocale'
import { applyTransformCode } from '@/utils/fenTransform'
import { puzzleDifficultyBand } from '@/utils/puzzleDifficultyColor'
import MiniBoard from '@/components/MiniBoard.vue'
import CategoryProgressTree from '@/components/CategoryProgressTree.vue'
import type { EloHistoryEntry } from '@/types'

const emit = defineEmits<{
  'browse-category': [category: string | null]
  'load-puzzle': [payload: { exerciseId: string; transformCode: string }]
}>()

const exercisesStore = useExercisesStore()
const { categoryProgressTree, overallProgress } = storeToRefs(exercisesStore)
const userProfileStore = useUserProfileStore()
const { profile } = storeToRefs(userProfileStore)
const { t } = useLocale()

// Only top-level categories, to avoid visual spam — details live in Browse Exercises.
const topLevelNodes = computed(() =>
  categoryProgressTree.value.map((node) => ({ ...node, children: [] })),
)

function onSelectCategory(value: string | null): void {
  emit('browse-category', value)
}

// Sum of elo changes from attempts within the last `days` days.
function eloDeltaSince(days: number): number {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  const history = profile.value?.eloHistory ?? []
  let sum = 0
  for (const entry of history) {
    if (new Date(entry.timestamp).getTime() >= cutoff) sum += entry.change
  }
  return sum
}

const eloDelta7d = computed((): number => eloDeltaSince(7))
const eloDelta30d = computed((): number => eloDeltaSince(30))

interface HistoryCard {
  entry: EloHistoryEntry
  displayFen: string | null
  puzzleElo: number | null
  expectedResult: string | null
}

// Pre-migration entries have no exerciseId (fen was stored directly back then) —
// they simply show the placeholder, same as any other entry with no reconstructable
// position. eloHistory/attempts are already capped to an 8-week rolling window, so
// this only ever applies to a short transition period.
const recentHistory = computed((): HistoryCard[] => {
  const history = profile.value?.eloHistory ?? []
  return [...history]
    .reverse()
    .slice(0, 16)
    .map((entry) => {
      const exercise = entry.exerciseId ? exercisesStore.exerciseById(entry.exerciseId) : undefined
      return {
        entry,
        displayFen: entry.exerciseId
          ? applyTransformCode(entry.exerciseId, entry.transformCode ?? '')
          : null,
        puzzleElo: exercise ? parseInt(exercise.difficulty) : null,
        expectedResult: exercise?.expectedResult ?? null,
      }
    })
})

function eloChangeLabel(change: number): string {
  return change >= 0 ? `+${change}` : `${change}`
}

// A puzzle far above the user's rating rounds its Elo change to zero, so the sign
// of the number alone would show a failed attempt as a green "+0".
function historyEloChangeSign(entry: EloHistoryEntry): 'positive' | 'negative' {
  if (entry.change === 0 && entry.solved === false) return 'negative'
  return entry.change >= 0 ? 'positive' : 'negative'
}

function historyEloChangeLabel(entry: EloHistoryEntry): string {
  if (entry.change === 0) return entry.solved === false ? '-0' : '+0'
  return eloChangeLabel(entry.change)
}

function eloBandClass(puzzleElo: number): string {
  return puzzleDifficultyBand(puzzleElo, profile.value?.endgameElo ?? 1400)
}

function onCardClick(entry: EloHistoryEntry): void {
  if (entry.exerciseId) {
    emit('load-puzzle', { exerciseId: entry.exerciseId, transformCode: entry.transformCode ?? '' })
  }
}
</script>

<template>
  <div class="solve-progress-page">
    <section v-if="profile" class="section">
      <h2 class="section-title">{{ t((s) => s.profile.eloTitle) }}</h2>
      <div class="elo-stats">
        <div class="elo-stat">
          <span class="elo-stat-value">{{ profile.endgameElo }}</span>
          <span class="elo-stat-label">{{ t((s) => s.profile.currentEloLabel) }}</span>
        </div>
        <div class="elo-stat">
          <span :class="['elo-stat-value', eloDelta7d >= 0 ? 'positive' : 'negative']">
            {{ eloChangeLabel(eloDelta7d) }}
          </span>
          <span class="elo-stat-label">{{ t((s) => s.profile.last7Days) }}</span>
        </div>
        <div class="elo-stat">
          <span :class="['elo-stat-value', eloDelta30d >= 0 ? 'positive' : 'negative']">
            {{ eloChangeLabel(eloDelta30d) }}
          </span>
          <span class="elo-stat-label">{{ t((s) => s.profile.last30Days) }}</span>
        </div>
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.categoryProgressTitle) }}</h2>
      <p v-if="topLevelNodes.length === 0" class="empty">
        {{ t((s) => s.profile.noExercisesAttempted) }}
      </p>
      <CategoryProgressTree
        v-else
        :nodes="topLevelNodes"
        :overall="overallProgress"
        navigable
        @select="onSelectCategory"
      />
    </section>

    <section class="section">
      <h2 class="section-title">{{ t((s) => s.profile.puzzleHistory) }}</h2>
      <p v-if="recentHistory.length === 0" class="empty">
        {{ t((s) => s.profile.noPuzzlesAttempted) }}
      </p>
      <div v-else class="history-grid">
        <div
          v-for="card in recentHistory"
          :key="card.entry.timestamp"
          :class="['history-card', card.entry.exerciseId ? 'clickable' : '']"
          :title="card.entry.exerciseId ? t((s) => s.profile.replayPuzzleTitle) : undefined"
          @click="onCardClick(card.entry)"
        >
          <div class="board-wrap">
            <MiniBoard v-if="card.displayFen" :fen="card.displayFen" />
            <div v-else class="board-placeholder">?</div>
          </div>
          <div class="card-meta">
            <span
              v-if="card.puzzleElo !== null"
              :class="['meta-chip', eloBandClass(card.puzzleElo)]"
            >
              {{ card.puzzleElo }}
            </span>
            <span v-if="card.expectedResult" :class="['meta-chip', card.expectedResult]">
              {{
                card.expectedResult === 'win'
                  ? t((s) => s.app.resultWin)
                  : t((s) => s.app.resultDraw)
              }}
            </span>
            <span :class="['meta-chip elo-change', historyEloChangeSign(card.entry)]">
              {{ historyEloChangeLabel(card.entry) }}
            </span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.solve-progress-page {
  width: 100%;
  max-width: 720px;
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
}

.section-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--fg);
}

.elo-stats {
  display: flex;
  gap: 1.5rem;
}

.elo-stat {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.elo-stat-value {
  font-size: 1.3rem;
  font-weight: 700;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
}

.elo-stat-value.positive {
  color: var(--color-solved);
}

.elo-stat-value.negative {
  color: var(--color-failed);
}

.elo-stat-label {
  font-size: 0.8rem;
  color: var(--muted);
}

.empty {
  font-size: 0.875rem;
  color: var(--muted);
}

.history-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.6rem;
}

@media (max-width: 560px) {
  .history-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

.history-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  padding: 0.4rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
}

.history-card.clickable {
  cursor: pointer;
  transition:
    border-color 0.15s,
    background 0.15s;
}

.history-card.clickable:hover {
  border-color: var(--accent);
  background: var(--hover-bg);
}

.board-wrap {
  width: 100%;
  border-radius: 2px;
  overflow: hidden;
}

.card-meta {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.3rem;
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

.meta-chip.elo-change.positive {
  border-color: var(--color-solved);
  color: var(--color-solved);
}

.meta-chip.elo-change.negative {
  border-color: var(--color-failed);
  color: var(--color-failed);
}

.board-placeholder {
  aspect-ratio: 1;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--badge-bg);
  color: var(--muted);
  font-size: 1.5rem;
  border-radius: 2px;
}
</style>
