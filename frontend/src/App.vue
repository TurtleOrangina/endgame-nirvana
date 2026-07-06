<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import confetti from 'canvas-confetti'
import { useExercisesStore } from '@/stores/exercises'
import { useUserProfileStore } from '@/stores/userProfile'
import { useAuthStore } from '@/stores/auth'
import { useSyncStore } from '@/stores/sync'
import { useStockfishEngine } from '@/composables/useStockfishEngine'
import { useResultAudio } from '@/composables/useResultAudio'
import { useLichessAuth } from '@/composables/useLichessAuth'
import { parseCurrentRoute, buildRouteUrl, matchLegalRoute } from '@/composables/useAppRouter'
import { useLocale } from '@/composables/useLocale'
import LegalPage from '@/components/LegalPage.vue'
import { useWakeLock } from '@/composables/useWakeLock'
import ChessBoard from '@/components/ChessBoard.vue'
import SetupModal from '@/components/SetupModal.vue'
import AnalysisPanel from '@/components/AnalysisPanel.vue'
import BoardNavControls from '@/components/BoardNavControls.vue'
import UserProfilePage from '@/components/UserProfilePage.vue'
import PasswordRecoveryModal from '@/components/PasswordRecoveryModal.vue'
import {
  PuzzleStatus,
  type GameResult,
  type EngineLine,
  type TablebaseResult,
  type AnalysisSettings,
  type ThemeMode,
} from '@/types'

const store = useExercisesStore()
const userProfileStore = useUserProfileStore()
const authStore = useAuthStore()
const syncStore = useSyncStore()
const lichessAuth = useLichessAuth()
const { passwordRecoveryRequested } = storeToRefs(authStore)
const {
  isLoading,
  categoryOptions,
  categoryExercises,
  currentExercise,
  currentTransformedFen,
  categoryPuzzleTotal,
  categoryPuzzleSolved,
  categoryPuzzleFailed,
  categoryPuzzleUnattempted,
  categoryHiddenCounts,
  selectedCategory,
  requestedPuzzleNotFound,
} = storeToRefs(store)

// The FEN the board actually renders — transformed for variety.
const currentBoardFen = computed(
  () => currentTransformedFen.value ?? currentExercise.value?.fen ?? null,
)
// The FEN used in URLs — always the puzzle's original fen, with underscores for the
// URL, regardless of which transformation is currently displayed. This is what lets
// a fresh page load re-roll a random orientation while the URL itself stays stable.
const currentRawFen = computed(() => currentExercise.value?.fen.replaceAll(' ', '_') ?? null)
const { profile, sessionSolved, sessionFailed, sessionEloChange, lastEloChange } =
  storeToRefs(userProfileStore)

// Decoupled from `profile` itself: signing up with email confirmation disabled (e.g. dev
// backends) authenticates and pulls a cloud profile immediately, part-way through the
// SetupModal wizard — closing on that alone would cut the wizard short mid-step.
// Only SetupModal's own `close` event (once its wizard is actually done) should dismiss it;
// a null profile (fresh app, or after sign-out) is the only thing that reopens it.
// Starts closed rather than `!profile.value`: at setup time `userProfileStore.load()` hasn't
// run yet (it awaits `authStore.init()` in `onMounted` below), so `profile` is always still
// null here even for returning users — opening eagerly would flash the modal on every refresh.
const setupWizardOpen = ref(false)
watch(profile, (p) => {
  if (!p) setupWizardOpen.value = true
})

const engine = useStockfishEngine()
const audio = useResultAudio()
const { t, setLocale } = useLocale()

const boardRef = ref<InstanceType<typeof ChessBoard> | null>(null)
const dropdownRef = ref<HTMLDetailsElement | null>(null)
const currentView = ref<'training' | 'profile' | 'impressum' | 'datenschutz'>('training')

// Keeps the screen awake while a board view is on screen, since puzzles can
// take a while to think through with no touch/scroll to reset the OS's dim timer.
useWakeLock(computed(() => currentView.value !== 'profile'))
const puzzleStatus = ref<PuzzleStatus>(PuzzleStatus.SOLVING)
const isWrongSolution = ref(false)
const isAnalysisMode = ref(false)
const analysisPaused = ref(false)
const analysisTablebaseExpanded = ref(false)
const analysisLines = ref<EngineLine[]>([])
const analysisTablebase = ref<TablebaseResult | null>(null)
const analysisFen = ref<string>('')
const analysisSettings = ref<AnalysisSettings>({
  thinkingTimeMs: 8000,
  numLines: 3,
  showBestArrow: true,
  showTablebaseArrow: true,
})

// Suppresses URL writes from the watcher during programmatic navigation.
let suppressUrlUpdate = false

function getRecentAttemptStatus(exerciseId: string): PuzzleStatus | null {
  const p = profile.value
  if (!p) return null
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  for (let i = p.eloHistory.length - 1; i >= 0; i--) {
    const entry = p.eloHistory[i]
    if (!entry) break
    if (new Date(entry.timestamp).getTime() < cutoff) break
    if (entry.exerciseId !== exerciseId) continue
    if (entry.solved === true) return PuzzleStatus.SUCCEEDED
    if (entry.solved === false) return PuzzleStatus.FAILED
  }
  return null
}

// flush:'sync' so the watcher fires synchronously during store mutations,
// allowing callers to override state (e.g. isAnalysisMode) immediately after.
watch(
  currentExercise,
  (exercise) => {
    if (!exercise) return
    const recent = getRecentAttemptStatus(exercise.id)
    puzzleStatus.value = recent ?? PuzzleStatus.SOLVING
    isWrongSolution.value = false
    isAnalysisMode.value = false
    analysisLines.value = []
    analysisTablebase.value = null
    analysisFen.value = ''
    if (!suppressUrlUpdate) {
      history.replaceState(null, '', buildRouteUrl('training', currentRawFen.value))
    }
  },
  { flush: 'sync' },
)

onMounted(async () => {
  const legalPage = matchLegalRoute(window.location.pathname)
  if (legalPage) {
    currentView.value = legalPage
    return
  }

  await authStore.init()
  syncStore.setUpAutoFlushListeners()
  userProfileStore.load()
  if (!profile.value) setupWizardOpen.value = true

  const params = new URLSearchParams(window.location.search)

  if (params.has('code')) {
    suppressUrlUpdate = true
    await lichessAuth.handleRedirectCallback()
    await store.load()
    history.replaceState(null, '', buildRouteUrl('training', currentRawFen.value))
    suppressUrlUpdate = false
    window.addEventListener('popstate', handlePopState)
    return
  }

  const route = parseCurrentRoute()
  suppressUrlUpdate = true

  if (route.view === 'profile') {
    await store.load()
    currentView.value = 'profile'
    history.replaceState(null, '', '/profile')
  } else {
    await store.load(route.fen ?? undefined)
    if (route.view === 'analysis' && currentExercise.value) {
      isAnalysisMode.value = true
      await nextTick()
      startAnalysisMode()
    }
    if (currentExercise.value) {
      history.replaceState(
        null,
        '',
        buildRouteUrl(route.view === 'analysis' ? 'analysis' : 'training', currentRawFen.value),
      )
    }
  }

  suppressUrlUpdate = false
  window.addEventListener('popstate', handlePopState)
})

onUnmounted(() => {
  window.removeEventListener('popstate', handlePopState)
  systemThemeQuery.removeEventListener('change', applySystemTheme)
})

const systemThemeQuery = window.matchMedia('(prefers-color-scheme: light)')

function applyTheme(mode: ThemeMode): void {
  const resolved = mode === 'system' ? (systemThemeQuery.matches ? 'light' : 'dark') : mode
  document.documentElement.dataset.theme = resolved
}

function applySystemTheme(): void {
  if (profile.value?.themeMode === 'system') applyTheme('system')
}

systemThemeQuery.addEventListener('change', applySystemTheme)

watch(
  () => profile.value?.themeMode,
  (mode) => applyTheme(mode ?? 'dark'),
  { immediate: true },
)

// While no profile exists yet (first run, setup wizard) the browser-detected
// default from useLocale stays in effect.
watch(
  () => profile.value?.language,
  (language) => {
    if (language) setLocale(language)
  },
  { immediate: true },
)

function handlePopState(): void {
  suppressUrlUpdate = true
  const route = parseCurrentRoute()

  if (route.view === 'profile') {
    currentView.value = 'profile'
    suppressUrlUpdate = false
    return
  }

  currentView.value = 'training'
  const activeRawFen = currentRawFen.value
  const exerciseChanged = route.fen && route.fen !== activeRawFen

  if (exerciseChanged && route.fen) {
    store.selectById(route.fen.replaceAll('_', ' '))
    // sync watcher has already reset isAnalysisMode to false
    if (route.view === 'analysis') {
      isAnalysisMode.value = true
      nextTick(() => {
        startAnalysisMode()
      }).catch(() => undefined)
    }
  } else {
    // Same exercise: handle analysis mode transition
    const enterAnalysis = route.view === 'analysis' && !isAnalysisMode.value
    const leaveAnalysis = route.view !== 'analysis' && isAnalysisMode.value
    if (enterAnalysis) {
      isAnalysisMode.value = true
      nextTick(() => {
        startAnalysisMode()
      }).catch(() => undefined)
    } else if (leaveAnalysis) {
      isAnalysisMode.value = false
      analysisPaused.value = false
      analysisLines.value = []
      analysisTablebase.value = null
      analysisFen.value = ''
      boardRef.value?.resetBoard()
    }
  }

  suppressUrlUpdate = false
}

const downloadPercent = computed(() => {
  const p = engine.downloadProgress.value
  return p ? Math.round(p.percent * 100) : 0
})

const engineStatusText = computed(() => {
  const p = engine.downloadProgress.value
  if (p) {
    return p.etaText
      ? t((s) => s.app.engineDownloadingWithEta, {
          percent: downloadPercent.value,
          speed: p.speedText,
          eta: p.etaText,
        })
      : t((s) => s.app.engineDownloading, { percent: downloadPercent.value, speed: p.speedText })
  }
  if (!engine.isReady.value) return t((s) => s.app.engineLoading)
  if (engine.isThinking.value) return t((s) => s.app.engineThinking)
  return null
})

const boardTitle = computed(() => {
  if (isAnalysisMode.value) return t((s) => s.app.analysisTitle)
  if (profile.value && currentExercise.value) {
    const turn = currentBoardFen.value?.split(' ')[1] ?? 'w'
    return turn === 'w' ? t((s) => s.app.youPlayWhite) : t((s) => s.app.youPlayBlack)
  }
  return 'Endgame Nirvana'
})

const eloChangeLabel = computed(() => {
  const change = lastEloChange.value
  if (!change) return null
  return change > 0 ? `+${change}` : `${change}`
})

const sessionDeltaLabel = computed(() => {
  const delta = sessionEloChange.value
  if (!delta) return null
  return delta > 0 ? `+${delta}` : `${delta}`
})

function onGameOver(result: GameResult): void {
  const exercise = currentExercise.value
  if (!exercise) return
  const passed = result === exercise.expectedResult
  if (puzzleStatus.value === PuzzleStatus.SOLVING || puzzleStatus.value === PuzzleStatus.FAILED) {
    const isRetry = puzzleStatus.value === PuzzleStatus.FAILED
    if (passed) {
      puzzleStatus.value = PuzzleStatus.SUCCEEDED
      audio.playSuccessSound()
      if (!isRetry) store.recordSolved()
      const boardEl = boardRef.value?.$el as HTMLElement | undefined
      const rect = boardEl?.getBoundingClientRect()
      const origin = rect
        ? {
            x: (rect.left + rect.width / 2) / window.innerWidth,
            y: (rect.top + rect.height / 2) / window.innerHeight,
          }
        : { y: 0.55 }
      confetti({ particleCount: 120, spread: 70, origin })
    } else {
      puzzleStatus.value = PuzzleStatus.FAILED
      isWrongSolution.value = true
      if (!isRetry) {
        store.recordFailed()
        audio.playFailureSound()
      }
    }
  } else {
    if (passed) audio.playSuccessSound()
    else audio.playFailureSound()
  }
}

// isWrongSolution always mirrors the latest engine/tablebase verdict for the current position —
// it's a live indicator, independent of PuzzleStatus (which tracks the once-per-attempt rated
// outcome and never reverts once FAILED).
function onGoalEvaluated(isOutsideGoal: boolean): void {
  const justWentOffCourse = isOutsideGoal && !isWrongSolution.value
  isWrongSolution.value = isOutsideGoal
  if (justWentOffCourse) audio.playFailureSound()
  if (isOutsideGoal && puzzleStatus.value === PuzzleStatus.SOLVING) {
    puzzleStatus.value = PuzzleStatus.FAILED
    store.recordFailed()
  }
}

function resetPuzzle(): void {
  puzzleStatus.value = PuzzleStatus.FAILED
  isWrongSolution.value = false
  analysisLines.value = []
  analysisTablebase.value = null
  analysisFen.value = ''
  boardRef.value?.resetBoard()
}

// Re-rolls a fresh random orientation for the same exercise before resetting the
// board — `resetBoard()` re-reads `props.fen` at call time, and `nextTick()` here
// ensures that prop has already picked up the new transform before it's called.
async function onRetry(): Promise<void> {
  const exercise = currentExercise.value
  if (exercise) store.selectById(exercise.id)
  await nextTick()
  resetPuzzle()
}

function onTakeBack(): void {
  if (puzzleStatus.value === PuzzleStatus.SOLVING) {
    puzzleStatus.value = PuzzleStatus.FAILED
  }
  // The position we're rewinding to hasn't been re-evaluated yet — the next move will.
  isWrongSolution.value = false
  boardRef.value?.takeBack()
}

function onNext(): void {
  history.pushState(null, '', window.location.href)
  isWrongSolution.value = false
  store.advanceToNext()
}

function onSurrender(): void {
  puzzleStatus.value = PuzzleStatus.FAILED
  isWrongSolution.value = false
  store.recordFailed()
  audio.playFailureSound()
}

// Enters analysis mode with the user's remembered preferences (engine pause, tablebase
// expansion) already applied. The pause state must be passed into enterAnalysisMode()
// rather than set afterwards: entering unpaused would launch an engine search that a
// follow-up pause cannot reliably cancel (the search starts asynchronously), leaving
// the engine burning CPU in the background with its results discarded.
function startAnalysisMode(): void {
  const paused = profile.value?.analysisEnginePaused ?? false
  analysisPaused.value = paused
  analysisTablebaseExpanded.value = profile.value?.tablebaseMovesExpanded ?? false
  boardRef.value?.enterAnalysisMode(paused)
}

function onAnalyse(): void {
  if (puzzleStatus.value === PuzzleStatus.SOLVING) {
    puzzleStatus.value = PuzzleStatus.FAILED
    store.recordFailed()
    audio.playFailureSound()
  }
  isAnalysisMode.value = true
  startAnalysisMode()
  history.pushState(null, '', buildRouteUrl('analysis', currentRawFen.value))
}

function onLeaveAnalysis(): void {
  isAnalysisMode.value = false
  analysisPaused.value = false
  puzzleStatus.value = PuzzleStatus.FAILED
  isWrongSolution.value = false
  analysisLines.value = []
  analysisTablebase.value = null
  analysisFen.value = ''
  boardRef.value?.leaveAnalysisMode()
  history.replaceState(null, '', buildRouteUrl('training', currentRawFen.value))
}

function onToggleEngine(): void {
  analysisPaused.value = !analysisPaused.value
  boardRef.value?.setAnalysisPaused(analysisPaused.value)
  userProfileStore.setAnalysisEnginePaused(analysisPaused.value)
}

function onToggleTablebaseExpand(): void {
  analysisTablebaseExpanded.value = !analysisTablebaseExpanded.value
  userProfileStore.setTablebaseMovesExpanded(analysisTablebaseExpanded.value)
}

function onAnalysisUpdate(
  lines: EngineLine[],
  tablebaseResult: TablebaseResult | null,
  fen: string,
): void {
  analysisLines.value = lines
  analysisTablebase.value = tablebaseResult
  analysisFen.value = fen
}

function onAnalysisSettingsChange(settings: AnalysisSettings): void {
  analysisSettings.value = settings
}

function onExecuteMove(uci: string): void {
  boardRef.value?.makeMove(uci)
}

function onLoadFen(fen: string): void {
  boardRef.value?.loadFen(fen)
}

function onHoverMove(uci: string | null): void {
  boardRef.value?.showMoveArrow(uci)
}

const selectedCategoryLabel = computed(
  () => selectedCategory.value?.split('/').join(' › ') ?? t((s) => s.app.allCategories),
)

const emptyBoardSquares = Array.from({ length: 64 }, (_, index) => ({
  index,
  dark: (Math.floor(index / 8) + (index % 8)) % 2 === 1,
}))

// Every ancestor path prefix of a category value, e.g. "A/B/C" -> ["A", "A/B"].
// Used to pre-expand the tree down to whatever category is currently selected.
function ancestorsOf(value: string | null): string[] {
  if (!value) return []
  const segments = value.split('/')
  const prefixes: string[] = []
  let prefix = ''
  for (const segment of segments.slice(0, -1)) {
    prefix = prefix ? `${prefix}/${segment}` : segment
    prefixes.push(prefix)
  }
  return prefixes
}

const expandedCategories = ref<Set<string>>(new Set(ancestorsOf(selectedCategory.value)))

function toggleCategoryExpanded(value: string): void {
  const next = new Set(expandedCategories.value)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  expandedCategories.value = next
}

// categoryOptions is a depth-first flattened tree. Collapsing a node hides every
// following option whose depth is greater than that node's, until we come back out to
// its own depth or shallower.
const visibleCategoryOptions = computed(() => {
  const options = categoryOptions.value
  const result: { label: string; value: string; depth: number; hasChildren: boolean }[] = []
  let collapseFromDepth: number | null = null
  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    if (!opt) continue
    if (collapseFromDepth !== null && opt.depth > collapseFromDepth) continue
    collapseFromDepth = null
    const hasChildren = (options[i + 1]?.depth ?? -1) > opt.depth
    result.push({ ...opt, hasChildren })
    if (hasChildren && !expandedCategories.value.has(opt.value)) {
      collapseFromDepth = opt.depth
    }
  }
  return result
})

// Widens the difficulty preference just enough to include puzzles above the user's
// level: 'around' -> 'aroundAndAbove', 'aroundAndBelow' -> 'all'. (Preferences that
// already include everything above the user's level never hide puzzles as "too hard",
// so this button can only ever be shown for those two starting values.)
function allowSolvingTooHard(): void {
  const current = profile.value?.difficultyPreference ?? 'around'
  const next = current === 'aroundAndBelow' ? 'all' : 'aroundAndAbove'
  userProfileStore.setDifficultyPreference(next)
  store.onDifficultyPreferenceChanged()
}

function selectCategory(cat: string | null): void {
  store.setCategory(cat)
  if (dropdownRef.value) dropdownRef.value.open = false
}

// depth 0 selects the top-level category, depth 1 additionally narrows to the subcategory, etc.
function selectCategoryFromChip(depth: number): void {
  const exercise = currentExercise.value
  if (!exercise) return
  selectCategory(exercise.categoryPath.slice(0, depth + 1).join('/'))
}

function navigateToTraining(): void {
  history.pushState(null, '', buildRouteUrl('training', currentRawFen.value))
  currentView.value = 'training'
}

function navigateToProfile(): void {
  history.pushState(null, '', '/profile')
  currentView.value = 'profile'
}

function handleLoadPuzzle(payload: { exerciseId: string; transformCode: string }): void {
  suppressUrlUpdate = true
  store.selectByIdWithTransform(payload.exerciseId, payload.transformCode)
  suppressUrlUpdate = false
  currentView.value = 'training'
  history.pushState(null, '', buildRouteUrl('training', currentRawFen.value))
  // sync watcher already reset isAnalysisMode, analysisLines, etc.
}
</script>

<template>
  <SetupModal v-if="setupWizardOpen" @close="setupWizardOpen = false" />
  <PasswordRecoveryModal v-if="passwordRecoveryRequested" />

  <div class="app">
    <LegalPage
      v-if="currentView === 'impressum' || currentView === 'datenschutz'"
      :page="currentView"
    />

    <UserProfilePage
      v-else-if="currentView === 'profile'"
      @back="navigateToTraining()"
      @load-puzzle="handleLoadPuzzle"
    />

    <div v-else-if="isLoading" class="loading">{{ t((s) => s.app.loadingExercises) }}</div>

    <template v-else>
      <div class="page">
        <div class="app-header">
          <div class="header-left">
            <span class="board-title">{{ boardTitle }}</span>
          </div>

          <button
            v-if="profile"
            class="btn-profile-nav"
            :title="t((s) => s.app.profileButtonTitle, { username: profile.username })"
            @click="navigateToProfile()"
          >
            {{ profile.username }}
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <circle cx="12" cy="10" r="3" />
              <path d="M6.168 18.849A4 4 0 0 1 10 16h4a4 4 0 0 1 3.834 2.855" />
            </svg>
          </button>
        </div>

        <div class="layout two-col">
          <section class="board-area">
            <ChessBoard
              v-if="currentExercise"
              ref="boardRef"
              :key="currentExercise.id"
              :fen="currentBoardFen ?? currentExercise.fen"
              :analysis-settings="analysisSettings"
              :is-rated-attempt="puzzleStatus === PuzzleStatus.SOLVING"
              @game-over="onGameOver"
              @goal-evaluated="onGoalEvaluated"
              @analysis-update="onAnalysisUpdate"
            />
            <div v-else class="empty-board" aria-hidden="true">
              <div
                v-for="square in emptyBoardSquares"
                :key="square.index"
                class="empty-board-square"
                :class="{ dark: square.dark }"
              />
            </div>
          </section>

          <div class="sidebar">
            <!-- Analysis mode panel replaces normal sidebar content -->
            <template v-if="isAnalysisMode">
              <BoardNavControls
                :can-jump-back="boardRef?.canJumpBack ?? false"
                :can-jump-forward="boardRef?.canJumpForward ?? false"
                :can-play-best-move="boardRef?.canPlayBestMove ?? false"
                :is-finding-best-move="boardRef?.isFindingBestMove ?? false"
                :move-counter="
                  boardRef
                    ? {
                        displayMovesSinceZero: boardRef.displayMovesSinceZero,
                        pinnedTooltip: boardRef.pinnedTooltip,
                      }
                    : undefined
                "
                @jump-start="boardRef?.jumpToStart()"
                @step-back="boardRef?.stepBack()"
                @play-best-move="boardRef?.playBestMove()"
                @step-forward="boardRef?.stepForward()"
                @jump-end="boardRef?.jumpToEnd()"
                @toggle-tooltip="boardRef?.toggleTooltip($event)"
              />
              <AnalysisPanel
                :lines="analysisLines"
                :tablebase-result="analysisTablebase"
                :is-thinking="engine.isThinking.value"
                :engine-paused="analysisPaused"
                :tablebase-expanded="analysisTablebaseExpanded"
                :fen="analysisFen"
                :settings="analysisSettings"
                @leave-analysis="onLeaveAnalysis"
                @settings-change="onAnalysisSettingsChange"
                @execute-move="onExecuteMove"
                @hover-move="onHoverMove"
                @toggle-engine="onToggleEngine"
                @toggle-tablebase-expand="onToggleTablebaseExpand"
                @load-fen="onLoadFen"
              />
            </template>

            <template v-else>
              <template v-if="currentExercise">
                <!-- Action buttons -->
                <section v-if="puzzleStatus === PuzzleStatus.SOLVING" class="actions">
                  <button
                    class="btn-action btn-surrender"
                    :title="t((s) => s.app.surrenderTitle)"
                    @click="onSurrender"
                  >
                    {{ t((s) => s.app.surrender) }}
                  </button>
                </section>

                <BoardNavControls
                  :can-jump-back="boardRef?.canJumpBack ?? false"
                  :can-jump-forward="boardRef?.canJumpForward ?? false"
                  :can-play-best-move="boardRef?.canPlayBestMove ?? false"
                  :is-finding-best-move="boardRef?.isFindingBestMove ?? false"
                  :move-counter="
                    boardRef
                      ? {
                          displayMovesSinceZero: boardRef.displayMovesSinceZero,
                          pinnedTooltip: boardRef.pinnedTooltip,
                        }
                      : undefined
                  "
                  @jump-start="boardRef?.jumpToStart()"
                  @step-back="boardRef?.stepBack()"
                  @play-best-move="boardRef?.playBestMove()"
                  @step-forward="boardRef?.stepForward()"
                  @jump-end="boardRef?.jumpToEnd()"
                  @toggle-tooltip="boardRef?.toggleTooltip($event)"
                />

                <section v-if="puzzleStatus !== PuzzleStatus.SOLVING" class="actions">
                  <button
                    class="btn-action btn-take-back"
                    :disabled="!boardRef?.hasMoves"
                    :title="t((s) => s.app.takeBackTitle)"
                    @click="onTakeBack"
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
                      <path d="M9 14 4 9l5-5" />
                      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                    </svg>
                    {{ t((s) => s.app.takeBack) }}
                  </button>

                  <button
                    class="btn-action btn-retry"
                    :title="t((s) => s.app.retryTitle)"
                    @click="onRetry"
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
                      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                      <path d="M3 3v5h5" />
                    </svg>
                    {{ t((s) => s.app.retry) }}
                  </button>

                  <button
                    class="btn-action btn-next"
                    :title="t((s) => s.app.nextTitle)"
                    @click="onNext"
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
                      <path d="M5 12h14" />
                      <path d="m12 5 7 7-7 7" />
                    </svg>
                    {{ t((s) => s.app.next) }}
                  </button>
                </section>

                <!-- Wrong solution indicator -->
                <div v-if="isWrongSolution" class="wrong-solution">
                  {{ t((s) => s.app.wrongSolution) }}
                </div>

                <!-- Analyse button -->
                <button
                  v-if="puzzleStatus !== PuzzleStatus.SOLVING"
                  class="btn-action btn-analyse"
                  @click="onAnalyse"
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
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                  {{ t((s) => s.app.analyse) }}
                </button>
              </template>

              <!-- Stats area -->
              <section v-if="profile" class="stats">
                <div class="stat-row">
                  <span class="stat-label">{{ t((s) => s.app.currentLevel) }}</span>
                  <span class="stat-value">{{ profile.endgameElo }}</span>
                  <span
                    v-if="eloChangeLabel"
                    :class="['elo-delta', (lastEloChange ?? 0) > 0 ? 'positive' : 'negative']"
                  >
                    {{ eloChangeLabel }}
                  </span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">{{ t((s) => s.app.session) }}</span>
                  <span class="stat-solved">
                    {{ t((s) => s.app.solvedCount, { count: sessionSolved }) }}
                  </span>
                  <span class="stat-sep"></span>
                  <span class="stat-failed">
                    {{ t((s) => s.app.failedCount, { count: sessionFailed }) }}
                  </span>
                  <span
                    v-if="sessionDeltaLabel"
                    :class="['elo-delta', sessionEloChange > 0 ? 'positive' : 'negative']"
                  >
                    ({{ sessionDeltaLabel }})
                  </span>
                </div>
              </section>

              <!-- Exercise meta chips -->
              <section
                v-if="currentExercise && puzzleStatus !== PuzzleStatus.SOLVING"
                class="exercise-meta"
              >
                <span
                  class="tag tag-category"
                  :title="t((s) => s.app.categoryChipTitle)"
                  @click="selectCategoryFromChip(0)"
                >
                  {{ currentExercise.category }}
                </span>
                <span
                  v-if="currentExercise.subcategory"
                  class="tag tag-category"
                  :title="t((s) => s.app.subcategoryChipTitle)"
                  @click="selectCategoryFromChip(1)"
                >
                  {{ currentExercise.subcategory }}
                </span>
                <span class="tag">{{ currentExercise.difficulty }}</span>
                <span class="tag" :class="currentExercise.expectedResult">
                  {{
                    currentExercise.expectedResult === 'win'
                      ? t((s) => s.app.resultWin)
                      : currentExercise.expectedResult === 'draw'
                        ? t((s) => s.app.resultDraw)
                        : t((s) => s.app.resultLoss)
                  }}
                </span>
              </section>

              <!-- Category filter -->
              <section class="filters">
                <details ref="dropdownRef" class="dropdown">
                  <summary>
                    {{ selectedCategoryLabel }}
                    <svg
                      class="chevron"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </summary>
                  <div class="dropdown-panel">
                    <div
                      class="option"
                      :class="{ selected: selectedCategory === null }"
                      @click="selectCategory(null)"
                    >
                      {{ t((s) => s.app.allCategories) }}
                    </div>
                    <div
                      v-for="opt in visibleCategoryOptions"
                      :key="opt.value"
                      class="option"
                      :class="{ selected: selectedCategory === opt.value }"
                      :style="{ paddingLeft: `calc(0.5rem + ${opt.depth} * 1rem)` }"
                      @click="selectCategory(opt.value)"
                    >
                      <button
                        v-if="opt.hasChildren"
                        class="option-expand"
                        :class="{ expanded: expandedCategories.has(opt.value) }"
                        :title="
                          expandedCategories.has(opt.value)
                            ? t((s) => s.common.collapse)
                            : t((s) => s.common.expand)
                        "
                        @click.stop="toggleCategoryExpanded(opt.value)"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="2.5"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <polyline points="9 6 15 12 9 18" />
                        </svg>
                      </button>
                      <span v-else-if="opt.depth > 0" class="option-marker">∟</span>
                      {{ opt.label }}
                    </div>
                  </div>
                </details>

                <div class="category-progress">
                  <div class="progress-track">
                    <div
                      v-if="categoryPuzzleSolved > 0"
                      class="progress-seg solved"
                      :style="{ flexGrow: categoryPuzzleSolved }"
                    />
                    <div
                      v-if="categoryPuzzleFailed > 0"
                      class="progress-seg failed"
                      :style="{ flexGrow: categoryPuzzleFailed }"
                    />
                    <div
                      v-if="categoryPuzzleUnattempted > 0"
                      class="progress-seg unattempted"
                      :style="{ flexGrow: categoryPuzzleUnattempted }"
                    />
                  </div>
                  <span class="progress-label">
                    {{
                      t((s) => s.app.progressSummary, {
                        solved: categoryPuzzleSolved,
                        failed: categoryPuzzleFailed,
                        left: categoryPuzzleUnattempted,
                      })
                    }}
                  </span>
                </div>
              </section>

              <div v-if="requestedPuzzleNotFound" class="empty">
                <p>{{ t((s) => s.app.unknownPuzzle) }}</p>
                <button class="btn-action" @click="store.advanceToNext()">
                  {{ t((s) => s.app.unknownPuzzleNext) }}
                </button>
              </div>

              <div v-else-if="!currentExercise && categoryExercises.length === 0" class="empty">
                {{ t((s) => s.app.noMatchingExercises) }}
              </div>

              <div v-else-if="!currentExercise" class="empty celebrate">
                <p>{{ t((s) => s.app.allSolvedInCategory) }}</p>
                <p v-if="categoryHiddenCounts.tooHard > 0">
                  {{ t((s) => s.app.hiddenTooHard, { count: categoryHiddenCounts.tooHard }) }}
                </p>
                <button
                  v-if="categoryHiddenCounts.tooHard > 0"
                  class="btn-action btn-allow-harder"
                  @click="allowSolvingTooHard"
                >
                  {{ t((s) => s.app.allowSolvingTooHard) }}
                </button>
                <p v-if="categoryHiddenCounts.tooEasy > 0">
                  {{ t((s) => s.app.hiddenTooEasy, { count: categoryHiddenCounts.tooEasy }) }}
                </p>
              </div>

              <!-- Engine status -->
              <div v-if="currentExercise && engineStatusText" class="engine-status">
                <template v-if="engine.downloadProgress.value">
                  <div class="dl-bar-track">
                    <div class="dl-bar-fill" :style="{ width: `${downloadPercent}%` }" />
                  </div>
                </template>
                <span class="engine-status-text">{{ engineStatusText }}</span>
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
}

:root {
  --bg: #1a1a2e;
  --fg: #e0e0e0;
  --surface: #16213e;
  --border: #333344;
  --muted: #aaaaaa;
  --hover-bg: #0f3460;
  --badge-bg: #333344;
  --accent: #c9a84c;
  --accent-darker: #a88a30;
  --track-bg: #333344;
  --tag-win-border: #2d6a4f;
  --tag-win-fg: #74c69d;
  --tag-draw-border: #555555;
  --tag-draw-fg: #aaaaaa;
  --btn-danger-border: #e06070;
  --btn-danger-fg: #e06070;
  --btn-danger-hover-bg: rgba(224, 96, 112, 0.12);
  --btn-success-bg: #2d7a50;
  --btn-success-border: #2d7a50;
  --btn-success-hover-bg: #236040;
  --color-solved: #74c69d;
  --color-failed: #e06070;
  --color-warning-border: #b8860b;
  --color-warning-fg: #e0b04c;
  --color-warning-bg: rgba(184, 134, 11, 0.12);
}

:root[data-theme='light'] {
  --bg: #f4f4f8;
  --fg: #1a1a2e;
  --surface: #ffffff;
  --border: #d0d0d8;
  --muted: #666666;
  --hover-bg: #e8e8f2;
  --badge-bg: #e0e0ea;
  --accent: #dca200;
  --accent-darker: #b08400;
  --track-bg: #d8d8e2;
  --tag-win-border: #2d7a50;
  --tag-win-fg: #1a6b3a;
  --tag-draw-border: #999999;
  --tag-draw-fg: #555555;
  --btn-danger-border: #c0404f;
  --btn-danger-fg: #c0404f;
  --btn-danger-hover-bg: rgba(192, 64, 79, 0.08);
  --btn-success-bg: #2a7a4e;
  --btn-success-border: #2a7a4e;
  --btn-success-hover-bg: #1f6040;
  --color-solved: #2a7a4e;
  --color-failed: #c0404f;
  --color-warning-border: #b08400;
  --color-warning-fg: #8a6800;
  --color-warning-bg: rgba(176, 132, 0, 0.1);
}

html {
  /* Off-screen elements that are only hidden via opacity (e.g. the move-counter
     tooltips in MoveCounters.vue) still expand the document's scrollable area
     even though nothing is visibly overflowing — clip it at the root instead of
     chasing every individual source. */
  overflow-x: hidden;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, sans-serif;
  min-height: 100vh;
  overflow-x: hidden;
}
</style>

<style scoped>
.app {
  padding: 1.5rem 1rem 3rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1.25rem;
}

.layout {
  width: 100%;
  max-width: 680px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  align-items: stretch;
}

.layout.two-col {
  max-width: none;
  flex-direction: row;
  align-items: flex-start;
  gap: 2rem;
}

.page {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.app-header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 2rem;
}

.header-left {
  flex: 0 0 auto;
  width: min(calc(100vw - 320px - 4rem), calc(100vh - 7rem));
  min-width: 260px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.board-area {
  flex: 0 0 auto;
  width: min(calc(100vw - 320px - 4rem), calc(100vh - 7rem));
  min-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.board-title {
  font-size: 1.2rem;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--accent);
}

.empty-board {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  grid-template-rows: repeat(8, 1fr);
  width: 100%;
  aspect-ratio: 1;
  border-radius: 4px;
  overflow: hidden;
  border: 1px solid var(--border);
}

.empty-board-square {
  background: var(--surface);
}

.empty-board-square.dark {
  background: var(--badge-bg);
}

.sidebar {
  flex: 0 0 280px;
  min-width: 240px;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

@media (max-width: 720px) {
  .layout.two-col {
    flex-direction: column;
    max-width: 680px;
    align-items: center;
  }

  .board-area {
    width: 100%;
    min-width: 0;
  }

  .sidebar {
    width: 100%;
    flex: none;
  }

  /* The board goes full-width below, but the header stays a single row, so the
     move bubbles can no longer line up with the board's right edge here. */
  .header-left {
    width: auto;
    min-width: 0;
    flex: 1 1 auto;
  }
}

.btn-profile-nav {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  margin-left: auto;
  padding: 0.3rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--fg);
  font-size: 0.8rem;
  cursor: pointer;
  transition:
    background 0.1s,
    border-color 0.1s,
    color 0.1s;
  white-space: nowrap;
  flex-shrink: 0;
}

.btn-profile-nav svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.btn-profile-nav:hover {
  background: var(--hover-bg);
}

.loading {
  margin-top: 4rem;
  color: var(--muted);
}

/* ── Filters ─────────────────────────────────────────────── */
.filters {
  width: 100%;
}

.dropdown {
  position: relative;
  width: 100%;
}

.dropdown summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.4rem 0.85rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 0.9rem;
  color: var(--fg);
  user-select: none;
}

.dropdown summary::-webkit-details-marker {
  display: none;
}

.dropdown[open] summary {
  border-color: var(--accent);
  color: var(--accent);
}

.chevron {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.dropdown-panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 100;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 0.4rem;
  max-height: 300px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.option {
  display: flex;
  align-items: center;
  padding: 0.35rem 0.5rem;
  border-radius: 5px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: background 0.1s;
}

.option:hover {
  background: var(--hover-bg);
}

.option.selected {
  background: var(--badge-bg);
  font-weight: 600;
}

.option-marker {
  color: var(--muted);
  margin-right: 0.3rem;
}

.option-expand {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-right: 0.2rem;
  margin-left: -0.2rem;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  padding: 0;
  border-radius: 3px;
  transition: color 0.1s;
}

.option-expand:hover {
  color: var(--fg);
}

.option-expand svg {
  width: 12px;
  height: 12px;
  transition: transform 0.1s;
}

.option-expand.expanded svg {
  transform: rotate(90deg);
}

.category-progress {
  margin-top: 0.5rem;
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.progress-track {
  flex: 1;
  height: 6px;
  display: flex;
  background: var(--track-bg);
  border-radius: 3px;
  overflow: hidden;
}

.progress-seg {
  flex-basis: 0;
  min-width: 0;
  height: 100%;
  transition: flex-grow 0.25s ease;
}

.progress-seg.solved {
  background: var(--color-solved);
}

.progress-seg.failed {
  background: var(--color-failed);
}

.progress-seg.unattempted {
  background: var(--track-bg);
}

.progress-label {
  font-size: 0.8rem;
  color: var(--muted);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* ── Stats ─────────────────────────────────────────────────── */
.stats {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.875rem;
}

.stat-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.stat-label {
  color: var(--muted);
}

.stat-value {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.stat-solved {
  color: var(--color-solved);
  font-weight: 600;
}

.stat-failed {
  color: var(--color-failed);
  font-weight: 600;
}

.stat-sep {
  color: var(--muted);
}

.elo-delta {
  font-weight: 700;
  font-size: 0.8rem;
}

.elo-delta.positive {
  color: var(--color-solved);
}

.elo-delta.negative {
  color: var(--color-failed);
}

/* ── Meta ─────────────────────────────────────────────────── */
.exercise-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
}

.tag {
  padding: 0.15rem 0.55rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  white-space: nowrap;
  font-size: 0.8rem;
  color: var(--muted);
}

.tag.win {
  border-color: var(--tag-win-border);
  color: var(--tag-win-fg);
}

.tag.draw {
  border-color: var(--tag-draw-border);
  color: var(--tag-draw-fg);
}

.tag-category {
  cursor: pointer;
  border-color: #5c9ee4;
  color: #5c9ee4;
  transition:
    background 0.1s,
    color 0.1s;
}

.tag-category:hover {
  background: #0258b4;
  color: #ffffff;
}

/* ── Wrong solution ────────────────────────────────────────── */
.wrong-solution {
  color: var(--btn-danger-fg);
  font-size: 0.875rem;
  font-weight: 600;
}

/* ── Actions ──────────────────────────────────────────────── */
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.btn-action {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  border-radius: 8px;
  font-size: 0.875rem;
  cursor: pointer;
  transition:
    color 0.15s,
    border-color 0.15s,
    background 0.15s,
    opacity 0.15s;
  white-space: nowrap;
}

.btn-action svg {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.btn-action:disabled {
  opacity: 0.35;
  cursor: default;
}

.btn-take-back,
.btn-retry {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
}

.btn-take-back:hover:not(:disabled),
.btn-retry:hover:not(:disabled) {
  background: var(--hover-bg);
}

.btn-surrender {
  border: 1px solid var(--btn-danger-border);
  background: transparent;
  color: var(--btn-danger-fg);
}

.btn-surrender:hover:not(:disabled) {
  background: var(--btn-danger-hover-bg);
}

.btn-next {
  border: 1px solid var(--btn-success-border);
  background: var(--btn-success-bg);
  color: #ffffff;
}

.btn-next:hover:not(:disabled) {
  background: var(--btn-success-hover-bg);
  border-color: var(--btn-success-hover-bg);
}

.btn-analyse {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  width: 100%;
}

.btn-analyse:hover {
  background: var(--hover-bg);
}

/* ── Engine status ────────────────────────────────────────── */
.engine-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
}

.engine-status-text {
  font-size: 0.8rem;
  color: var(--muted);
  letter-spacing: 0.02em;
}

.dl-bar-track {
  width: 100%;
  height: 4px;
  background: var(--track-bg);
  border-radius: 2px;
  overflow: hidden;
}

.dl-bar-fill {
  height: 100%;
  background: #4a90d9;
  border-radius: 2px;
  transition: width 0.25s ease;
}

.empty {
  color: var(--muted);
  margin-top: 2rem;
}

.empty.celebrate {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--fg);
  text-align: center;
}

.empty.celebrate p {
  margin: 0.4rem 0 0;
}

.empty.celebrate p:first-child {
  margin-top: 0;
}

.empty.celebrate p:not(:first-child) {
  font-size: 0.85rem;
  font-weight: 400;
  color: var(--muted);
}

.btn-allow-harder {
  margin-top: 0.75rem;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
}

.btn-allow-harder:hover {
  background: var(--hover-bg);
}
</style>
