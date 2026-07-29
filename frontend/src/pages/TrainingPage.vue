<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import confetti from 'canvas-confetti'
import { useExercisesStore, type CategoryOption } from '@/stores/exercises'
import { useUserProfileStore } from '@/stores/userProfile'
import { useStockfishEngine } from '@/composables/useStockfishEngine'
import { useResultAudio } from '@/composables/useResultAudio'
import { buildRouteUrl, type AppView } from '@/composables/useAppRouter'
import { useLocale } from '@/composables/useLocale'
import { useWakeLock } from '@/composables/useWakeLock'
import { playerPiecesSortedByValue, type PieceName } from '@/utils/chess'
import { applyTransformCode } from '@/utils/fenTransform'
import {
  clearTrainingSnapshot,
  saveTrainingSnapshot,
  takeTrainingSnapshot,
} from '@/utils/trainingSessionState'
import ChessBoard from '@/components/ChessBoard.vue'
import AnalysisPanel from '@/components/AnalysisPanel.vue'
import BoardNavControls from '@/components/BoardNavControls.vue'
import CategorySolveCount from '@/components/CategorySolveCount.vue'
import {
  PuzzleStatus,
  type DifficultyPreference,
  type GameResult,
  type EngineLine,
  type TablebaseResult,
  type AnalysisSettings,
} from '@/types'

const props = defineProps<{
  // False while a standalone page is shown: the training view stays mounted (hidden via
  // v-show) so the puzzle in progress survives navigating away and back.
  active: boolean
  // Suppresses ChessBoard's intro text while the first-run setup wizard covers the board.
  suppressBoardIntro: boolean
}>()

const store = useExercisesStore()
const userProfileStore = useUserProfileStore()
const {
  isLoading,
  categoryOptions,
  currentExercise,
  currentTransformedFen,
  categoryPuzzleSolved,
  categoryPuzzleFailed,
  categoryPuzzleUnattempted,
  categoryHiddenUncompletedCounts,
  categoryEmptyReason,
  categorySolveRatePercent,
  overallProgress,
  selectedCategory,
  requestedPuzzleNotFound,
} = storeToRefs(store)
const { profile, sessionSolved, sessionFailed, sessionEloChange, lastEloChange } =
  storeToRefs(userProfileStore)

const engine = useStockfishEngine()
const audio = useResultAudio()
const { t } = useLocale()

const boardRef = ref<InstanceType<typeof ChessBoard> | null>(null)
const dropdownRef = ref<HTMLDetailsElement | null>(null)

// Keeps the screen awake while actually solving a puzzle, since puzzles can take a
// while to think through with no touch/scroll to reset the OS's dim timer.
useWakeLock(computed(() => props.active))

// Chessground caches its pixel bounds, and the window may be resized while the training
// view is hidden — re-measure whenever it becomes visible again.
watch(
  () => props.active,
  (active) => {
    if (active) nextTick(() => boardRef.value?.redraw()).catch(() => undefined)
  },
)

// Fixed width for the solved/total columns in the category dropdown, sized to the widest
// possible number (the overall total) so the counts line up across all options.
const categoryCountColumnWidth = computed(() => `${String(overallProgress.value.total).length}ch`)

// The FEN the board actually renders — transformed for variety.
const currentBoardFen = computed(
  () => currentTransformedFen.value ?? currentExercise.value?.fen ?? null,
)
// The FEN used in URLs — the *transformed* fen currently on the board, with underscores
// for the URL. Sharing the original instead would leave the recipient's app free to roll
// its own orientation, so the two people would be looking at mirrored/recolored boards
// and couldn't discuss a move by name. The puzzle behind such a URL is recovered by
// undoing the transformation (see the exercises store's resolveTransformedFen), since
// solves are still reported under the original fen.
const currentUrlFen = computed(() => currentBoardFen.value?.replaceAll(' ', '_') ?? null)
const shareUrl = computed(() =>
  currentUrlFen.value
    ? `${window.location.origin}${buildRouteUrl('training', currentUrlFen.value)}`
    : null,
)

// The URL this view currently stands for — the training page owns the /train and
// /analysis routes, so App.vue navigates back to it through this.
const currentRouteUrl = computed(() =>
  buildRouteUrl(isAnalysisMode.value ? 'analysis' : 'training', currentUrlFen.value),
)

const puzzleStatus = ref<PuzzleStatus>(PuzzleStatus.SOLVING)
const isWrongSolutionFlashVisible = ref(false)
let wrongSolutionFlashTimeout: ReturnType<typeof setTimeout> | undefined

// Flashes a "Wrong solution" banner over the board itself, so a failure is
// noticeable even with sounds off and without looking at the sidebar. Skipped
// when a game-end text (checkmate, draw reason, …) already occupies the board.
function flashWrongSolutionOnBoard(): void {
  if (boardRef.value?.isShowingGameEndText) {
    hideWrongSolutionFlash()
    return
  }
  isWrongSolutionFlashVisible.value = true
  clearTimeout(wrongSolutionFlashTimeout)
  wrongSolutionFlashTimeout = setTimeout(() => {
    isWrongSolutionFlashVisible.value = false
  }, 2000)
}

function hideWrongSolutionFlash(): void {
  clearTimeout(wrongSolutionFlashTimeout)
  isWrongSolutionFlashVisible.value = false
}

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

// Keyed on the exercise id rather than the currentExercise object itself: the
// background catalog refresh in exercises.ts's store.load() replaces `allExercises`
// (and therefore the object `currentExercise` resolves to) with fresh references even
// when the puzzle set hasn't changed, which would otherwise spuriously reset analysis
// mode and puzzle status for a puzzle that's still the one on the board.
// flush:'sync' so the watcher fires synchronously during store mutations,
// allowing callers to override state (e.g. isAnalysisMode) immediately after.
watch(
  () => currentExercise.value?.id,
  (id) => {
    const exercise = currentExercise.value
    if (!exercise || !id) return
    const recent = getRecentAttemptStatus(exercise.id)
    puzzleStatus.value = recent ?? PuzzleStatus.SOLVING
    isAnalysisMode.value = false
    clearAnalysisResults()
    if (!suppressUrlUpdate) {
      history.replaceState(null, '', buildRouteUrl('training', currentUrlFen.value))
    }
  },
  { flush: 'sync' },
)

function clearAnalysisResults(): void {
  analysisLines.value = []
  analysisTablebase.value = null
  analysisFen.value = ''
}

// Written on pagehide so the training page survives full page loads in the same tab —
// most importantly the Lichess OAuth link flow, which navigates to lichess.org and back.
function persistTrainingState(): void {
  const exercise = currentExercise.value
  const board = boardRef.value
  if (!exercise || !board) {
    clearTrainingSnapshot()
    return
  }
  saveTrainingSnapshot({
    exerciseId: exercise.id,
    transformCode: store.currentTransformCode,
    puzzleStatus: puzzleStatus.value,
    isAnalysisMode: isAnalysisMode.value,
    board: board.getBoardSnapshot(),
  })
}

onMounted(() => {
  window.addEventListener('pagehide', persistTrainingState)
  document.addEventListener('keydown', onNextPuzzleShortcut)
})

onUnmounted(() => {
  window.removeEventListener('pagehide', persistTrainingState)
  document.removeEventListener('keydown', onNextPuzzleShortcut)
  clearTimeout(linkCopiedTimeout)
})

// Restores the training page "as you left it" from the pagehide snapshot: same puzzle in
// the same orientation, same move history, same rated/retry status and analysis mode.
// A ?puzzle= URL showing a *different* position (another puzzle, or the same one in
// another orientation — e.g. a shared link pasted into this tab) wins over the snapshot,
// since that URL is the position the user asked to see. Returns whether the snapshot was
// applied.
async function restoreSavedTrainingState(requestedFen: string | null = null): Promise<boolean> {
  const snapshot = takeTrainingSnapshot()
  if (!snapshot) return false
  if (!store.exerciseById(snapshot.exerciseId)) return false
  if (requestedFen) {
    const snapshotFen = applyTransformCode(snapshot.exerciseId, snapshot.transformCode)
    if (requestedFen.replaceAll('_', ' ') !== snapshotFen) return false
  }

  store.selectByIdWithTransform(snapshot.exerciseId, snapshot.transformCode)
  puzzleStatus.value = snapshot.puzzleStatus

  await nextTick()
  const board = boardRef.value
  if (board) {
    if (snapshot.isAnalysisMode) {
      isAnalysisMode.value = true
      const paused = profile.value?.analysisEnginePaused ?? false
      analysisPaused.value = paused
      analysisTablebaseExpanded.value = profile.value?.tablebaseMovesExpanded ?? false
      board.restoreBoardSnapshot(snapshot.board, { active: true, paused })
    } else {
      board.restoreBoardSnapshot(snapshot.board, { active: false, paused: false })
    }
  }
  return true
}

// Startup step one: pull in the puzzle catalog, optionally aiming at a specific puzzle.
async function loadCatalog(fen: string | null): Promise<void> {
  suppressUrlUpdate = true
  await store.load(fen ?? undefined)
  suppressUrlUpdate = false
}

// Startup step two: bring the board back to where the session snapshot and the initial
// route left it. `updateUrl` is false when the app started on a standalone page (progress,
// browse, …): the puzzle is still restored underneath, but the URL must keep pointing at
// that page rather than at the puzzle waiting behind it.
async function restoreSession(
  request: { fen: string | null; wantsAnalysis: boolean },
  options: { updateUrl: boolean },
): Promise<void> {
  suppressUrlUpdate = true
  const restored = await restoreSavedTrainingState(request.fen)
  if (!restored && request.wantsAnalysis) enterAnalysisFromRoute()
  if (options.updateUrl && currentExercise.value) {
    history.replaceState(null, '', currentRouteUrl.value)
  }
  suppressUrlUpdate = false
}

// Enters analysis mode for the current exercise if the puzzle has actually been solved
// recently (see exercises store's hasSolvedRecently) — jumping straight into analysis for
// a puzzle that hasn't been solved would let the player read engine lines and then "solve"
// it with borrowed knowledge. Otherwise corrects the URL back to training so it doesn't
// claim analysis mode while the board stays in solving mode.
function enterAnalysisFromRoute(): void {
  const exercise = currentExercise.value
  if (exercise && store.hasSolvedRecently(exercise.id)) {
    isAnalysisMode.value = true
    nextTick(() => {
      startAnalysisMode()
    }).catch(() => undefined)
  } else {
    history.replaceState(null, '', buildRouteUrl('training', currentUrlFen.value))
  }
}

// Brings the board in line with a training/analysis route the user navigated to with the
// browser's back/forward buttons (see App.vue's popstate handler).
function applyRoute(route: { view: AppView; fen: string | null }): void {
  suppressUrlUpdate = true
  const wantsAnalysis = route.view === 'analysis'
  const positionChanged = route.fen && route.fen !== currentUrlFen.value

  if (positionChanged && route.fen) {
    store.selectByTransformedFen(route.fen.replaceAll('_', ' '))
    // sync watcher has already reset isAnalysisMode to false
    if (wantsAnalysis) enterAnalysisFromRoute()
  } else if (wantsAnalysis && !isAnalysisMode.value) {
    enterAnalysisFromRoute()
  } else if (!wantsAnalysis && isAnalysisMode.value) {
    isAnalysisMode.value = false
    analysisPaused.value = false
    clearAnalysisResults()
    boardRef.value?.resetBoard()
  }

  suppressUrlUpdate = false
}

// Puts a puzzle picked on another page (solve progress, browse exercises) on the board.
function loadPuzzle(payload: { exerciseId: string; transformCode: string }): void {
  suppressUrlUpdate = true
  store.selectByIdWithTransform(payload.exerciseId, payload.transformCode)
  suppressUrlUpdate = false
  history.pushState(null, '', currentRouteUrl.value)
  // sync watcher already reset isAnalysisMode, analysisLines, etc.
}

function navigateHere(): void {
  history.pushState(null, '', currentRouteUrl.value)
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

// Shown as the app header's title while the training view is the active page.
const headerTitle = computed(() => {
  if (isAnalysisMode.value) return t((s) => s.app.analysisTitle)
  if (profile.value && currentExercise.value) {
    const turn = currentBoardFen.value?.split(' ')[1] ?? 'w'
    return turn === 'w' ? t((s) => s.app.youPlayWhite) : t((s) => s.app.youPlayBlack)
  }
  return 'Endgame Nirvana'
})

// The starting material of both sides, shown as "player pieces vs computer pieces"
// board-piece sprites in place of the header title (falling back to the plain
// "You play white/black" title when there is no room — see AppHeader).
const headerVersusPieces = computed<{
  player: { color: 'white' | 'black'; pieces: PieceName[] }
  opponent: { color: 'white' | 'black'; pieces: PieceName[] }
} | null>(() => {
  if (isAnalysisMode.value) return null
  if (!profile.value || !currentExercise.value) return null
  const fen = currentBoardFen.value
  if (!fen) return null
  const playerColor = (fen.split(' ')[1] ?? 'w') === 'w' ? 'white' : 'black'
  const opponentColor = playerColor === 'white' ? 'black' : 'white'
  return {
    player: { color: playerColor, pieces: playerPiecesSortedByValue(fen, playerColor) },
    opponent: { color: opponentColor, pieces: playerPiecesSortedByValue(fen, opponentColor) },
  }
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
      flashWrongSolutionOnBoard()
      if (!isRetry) {
        store.recordFailed()
        audio.playFailureSound()
      }
    }
  } else {
    if (passed) audio.playSuccessSound()
    else {
      audio.playFailureSound()
      flashWrongSolutionOnBoard()
    }
  }
}

// Announces the moment the player goes off course (failure sound + board flash). Whether
// this is a *new* mistake comes from the board, which compares the verdict against the
// position the move was made from — so a wrong move played on a fresh branch after a
// takeback announces itself again, while continuing an already-lost line stays quiet.
// This is independent of PuzzleStatus (which tracks the once-per-attempt rated outcome and
// never reverts once FAILED); the sidebar "Wrong solution" text is instead derived from the
// verdict stored on the displayed history entry (ChessBoard's displayedIsOutsideGoal).
function onGoalEvaluated(isOutsideGoal: boolean, wasAlreadyOutsideGoal: boolean): void {
  if (isOutsideGoal && !wasAlreadyOutsideGoal) {
    audio.playFailureSound()
    flashWrongSolutionOnBoard()
  }
  if (isOutsideGoal && puzzleStatus.value === PuzzleStatus.SOLVING) {
    puzzleStatus.value = PuzzleStatus.FAILED
    store.recordFailed()
  }
}

// Deliberately keeps the current orientation: re-rolling colours and mirroring is
// disorienting when the player is trying the *same* position again. A fresh random
// transform is only rolled when a puzzle is newly opened (see the exercises store).
function onRetry(): void {
  puzzleStatus.value = PuzzleStatus.FAILED
  hideWrongSolutionFlash()
  clearAnalysisResults()
  boardRef.value?.resetBoard()
}

function onNext(): void {
  history.pushState(null, '', window.location.href)
  hideWrongSolutionFlash()
  store.advanceToNext()
}

// Mirrors the visibility of the "Next" button, so the shortcut only fires when the
// button it stands for is actually on screen.
const canGoToNextPuzzle = computed(
  () =>
    props.active &&
    !isAnalysisMode.value &&
    !!currentExercise.value &&
    puzzleStatus.value !== PuzzleStatus.SOLVING,
)

function onNextPuzzleShortcut(event: KeyboardEvent): void {
  if (event.key !== 'n' || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
    return
  if (!canGoToNextPuzzle.value) return
  event.preventDefault()
  onNext()
}

function onSurrender(): void {
  puzzleStatus.value = PuzzleStatus.FAILED
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
  history.pushState(null, '', buildRouteUrl('analysis', currentUrlFen.value))
}

const linkCopied = ref(false)
let linkCopiedTimeout: ReturnType<typeof setTimeout> | undefined

// Prefers the OS share sheet (lets the user pick a messenger app directly) where
// available — mainly mobile browsers — falling back to a clipboard copy with a
// brief confirmation elsewhere.
async function onShare(): Promise<void> {
  const url = shareUrl.value
  if (!url) return
  if (navigator.share) {
    try {
      await navigator.share({ url })
    } catch {
      // User cancelled the share sheet or the browser rejected it — nothing to do.
    }
    return
  }
  await navigator.clipboard.writeText(url)
  linkCopied.value = true
  clearTimeout(linkCopiedTimeout)
  linkCopiedTimeout = setTimeout(() => {
    linkCopied.value = false
  }, 2000)
}

function onLeaveAnalysis(): void {
  isAnalysisMode.value = false
  analysisPaused.value = false
  puzzleStatus.value = PuzzleStatus.FAILED
  clearAnalysisResults()
  boardRef.value?.leaveAnalysisMode()
  history.replaceState(null, '', buildRouteUrl('training', currentUrlFen.value))
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
  const result: (CategoryOption & { hasChildren: boolean })[] = []
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

// Widens the difficulty preference just enough to include puzzles on one side of the
// user's level, e.g. towards 'above': 'around' -> 'aroundAndAbove', 'aroundAndBelow' ->
// 'all'. (A preference that already includes everything on that side never hides puzzles
// there, so the corresponding button can only ever be shown for those two starting values.)
function widenDifficultyPreference(side: 'above' | 'below'): void {
  const current = profile.value?.difficultyPreference ?? 'around'
  const widened: DifficultyPreference =
    side === 'above'
      ? current === 'aroundAndBelow'
        ? 'all'
        : 'aroundAndAbove'
      : current === 'aroundAndAbove'
        ? 'all'
        : 'aroundAndBelow'
  userProfileStore.setDifficultyPreference(widened)
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

defineExpose({
  headerTitle,
  headerVersusPieces,
  loadCatalog,
  restoreSession,
  applyRoute,
  loadPuzzle,
  navigateHere,
})
</script>

<template>
  <div v-show="active" class="training-page">
    <div v-if="isLoading" class="loading">{{ t((s) => s.app.loadingExercises) }}</div>

    <div v-else class="layout two-col">
      <section class="board-area">
        <div v-if="currentExercise" class="board-wrap">
          <ChessBoard
            ref="boardRef"
            :key="currentExercise.id"
            :fen="currentBoardFen ?? currentExercise.fen"
            :analysis-settings="analysisSettings"
            :is-rated-attempt="puzzleStatus === PuzzleStatus.SOLVING"
            :suppress-intro="suppressBoardIntro"
            @game-over="onGameOver"
            @goal-evaluated="onGoalEvaluated"
            @analysis-update="onAnalysisUpdate"
          />
          <Transition name="wrong-solution-flash">
            <div v-if="isWrongSolutionFlashVisible" class="wrong-solution-flash">
              😞 {{ t((s) => s.app.wrongSolution) }} 😞
            </div>
          </Transition>
        </div>
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

              <button class="btn-action btn-analyse" @click="onAnalyse">
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

            <!-- Wrong solution indicator: derived from the verdict stored on the
                 displayed history entry, so it follows take-backs and arrow-key
                 history navigation. -->
            <div v-if="boardRef?.displayedIsOutsideGoal" class="wrong-solution">
              {{ t((s) => s.app.wrongSolution) }}
            </div>
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
              <div
                class="dropdown-panel"
                :style="{ '--count-column-width': categoryCountColumnWidth }"
              >
                <div
                  class="option"
                  :class="{ selected: selectedCategory === null }"
                  @click="selectCategory(null)"
                >
                  <span class="option-label">{{ t((s) => s.app.allCategories) }}</span>
                  <CategorySolveCount
                    :attempted="overallProgress.solved + overallProgress.failed"
                    :total="overallProgress.total"
                  />
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
                  <span class="option-label">{{ opt.label }}</span>
                  <CategorySolveCount :attempted="opt.attempted" :total="opt.total" />
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

          <template v-else-if="!currentExercise">
            <div v-if="categoryEmptyReason === 'allCompleted'" class="empty celebrate">
              <p>{{ t((s) => s.app.allCompletedInCategory) }}</p>
              <p v-if="categorySolveRatePercent !== null">
                {{ t((s) => s.app.categorySolveRate, { percent: categorySolveRatePercent }) }}
              </p>
            </div>

            <!-- Uncompleted puzzles are left, they are just hidden by the difficulty
                 preference: say how many, and offer to widen it. -->
            <div
              v-else-if="categoryEmptyReason === 'restHiddenByDifficulty'"
              class="empty celebrate"
            >
              <p>{{ t((s) => s.app.noMoreAvailableInCategory) }}</p>
              <template v-if="categoryHiddenUncompletedCounts.tooHard > 0">
                <p>
                  {{
                    t((s) => s.app.hiddenTooHard, {
                      count: categoryHiddenUncompletedCounts.tooHard,
                    })
                  }}
                </p>
                <button
                  class="btn-action btn-allow-other-difficulty"
                  @click="widenDifficultyPreference('above')"
                >
                  {{ t((s) => s.app.allowSolvingTooHard) }}
                </button>
              </template>
              <template v-if="categoryHiddenUncompletedCounts.tooEasy > 0">
                <p>
                  {{
                    t((s) => s.app.hiddenTooEasy, {
                      count: categoryHiddenUncompletedCounts.tooEasy,
                    })
                  }}
                </p>
                <button
                  class="btn-action btn-allow-other-difficulty"
                  @click="widenDifficultyPreference('below')"
                >
                  {{ t((s) => s.app.allowSolvingTooEasy) }}
                </button>
              </template>
            </div>

            <div v-else class="empty">{{ t((s) => s.app.noMatchingExercises) }}</div>
          </template>

          <!-- Engine status -->
          <div v-if="currentExercise && engineStatusText" class="engine-status">
            <template v-if="engine.downloadProgress.value">
              <div class="dl-bar-track">
                <div class="dl-bar-fill" :style="{ width: `${downloadPercent}%` }" />
              </div>
            </template>
            <span class="engine-status-text">{{ engineStatusText }}</span>
          </div>

          <!-- Share -->
          <button
            v-if="currentExercise"
            class="btn-action btn-share"
            :title="t((s) => s.app.shareTitle)"
            @click="onShare"
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
              <circle cx="18" cy="5" r="3" />
              <circle cx="6" cy="12" r="3" />
              <circle cx="18" cy="19" r="3" />
              <path d="m8.59 13.51 6.83 3.98" />
              <path d="m15.41 6.51-6.82 3.98" />
            </svg>
            {{ linkCopied ? t((s) => s.app.linkCopied) : t((s) => s.app.share) }}
          </button>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.training-page {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
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
  justify-content: center;
  gap: 2rem;
}

.board-area {
  flex: 0 0 auto;
  width: min(calc(100vw - 320px - 4rem), calc(100vh - 7rem));
  min-width: 260px;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
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

.option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

.board-wrap {
  position: relative;
  container-type: inline-size;
}

/* Styled like ChessBoard.vue's on-board texts (.game-intro / .game-end-reason):
   free-floating bold text with a shadow, sized relative to the board. */
.wrong-solution-flash {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 8%;
  font-size: 4.5cqw;
  font-weight: 800;
  white-space: nowrap;
  color: #dc2626;
  text-shadow:
    0 0 12px rgba(0, 0, 0, 0.8),
    0 2px 4px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}

.wrong-solution-flash-enter-active {
  transition:
    opacity 0.15s ease-out,
    transform 0.15s ease-out;
}

.wrong-solution-flash-leave-active {
  transition: opacity 0.5s ease;
}

.wrong-solution-flash-enter-from {
  opacity: 0;
  transform: scale(0.7);
}

.wrong-solution-flash-leave-to {
  opacity: 0;
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

.btn-retry {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
}

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
}

.btn-analyse:hover {
  background: var(--hover-bg);
}

.btn-share {
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
  width: 100%;
}

.btn-share:hover {
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

.btn-allow-other-difficulty {
  margin-top: 0.75rem;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--fg);
}

.btn-allow-other-difficulty:hover {
  background: var(--hover-bg);
}
</style>
