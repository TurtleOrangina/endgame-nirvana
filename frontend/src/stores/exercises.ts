import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useUserProfileStore } from '@/stores/userProfile'
import { applyTransformCode, pickRandomTransformCode } from '@/utils/fenTransform'
import { migrateLegacyExerciseId } from '@/utils/exerciseId'
import type { Tables } from '@/types/database'

interface PuzzleRow {
  id: string
  category_path: string
  expected_result: string
  current_elo: number
}

interface RawExercise {
  fen: string
  expected_result: string
  difficulty: string | number
}

const EXERCISES_CACHE_KEY = 'exercisesCache'
const EXERCISES_MANIFEST_URL = '/exercises-manifest.json'

interface ExercisesCache {
  puzzles: PuzzleRow[]
}

export interface Exercise {
  id: string
  path: string
  categoryPath: string[]
  categoryFullPath: string
  category: string
  subcategory: string | null
  fen: string
  difficulty: string
  expectedResult: string
}

// A node in the category selection dropdown, flattened with `depth` for indentation.
// `value` is the full category path (e.g. "Pawn Endgames/Square of the Pawn") used for filtering.
// attempted/total aggregate over the node's entire subtree, shown as completion in the dropdown,
// counting the same pool as the profile's solve progress (see countsTowardProgress).
export interface CategoryOption {
  label: string
  value: string
  depth: number
  attempted: number
  total: number
}

// `hidden` counts puzzles excluded by the difficulty filter; they are not part of `total`.
export interface SolveProgress {
  solved: number
  failed: number
  unattempted: number
  total: number
  hidden: number
}

// A node in the profile's solve-progress tree. Counts aggregate over the node's entire
// subtree, so a parent's counts reflect all of its descendants. solved + failed + unattempted === total;
// `hidden` counts puzzles excluded by the difficulty filter and is not part of `total`.
export interface CategoryProgressNode {
  label: string
  value: string
  depth: number
  solved: number
  failed: number
  unattempted: number
  total: number
  hidden: number
  children: CategoryProgressNode[]
}

const RECENT_ATTEMPT_EXCLUSION_MS = 8 * 7 * 24 * 60 * 60 * 1000

// The +/- elo range used by the 'around' difficulty preference, and the floor/ceiling offset
// for 'aroundAndAbove' / 'aroundAndBelow'.
const ELO_BAND = 200

// Minimum number of puzzles the 'around' preference tries to guarantee on each side of the
// user's elo, so a sparse region of the puzzle distribution doesn't leave them with nothing.
const CLOSEST_PUZZLE_COUNT = 100

function extractCategoryPath(path: string): string[] {
  const trimmed = path.startsWith('/') ? path.slice(1) : path
  return trimmed.split('/')
}

function loadExercisesCache(): ExercisesCache | null {
  try {
    const raw = localStorage.getItem(EXERCISES_CACHE_KEY)
    return raw ? (JSON.parse(raw) as ExercisesCache) : null
  } catch {
    return null
  }
}

function persistExercisesCache(cache: ExercisesCache): void {
  localStorage.setItem(EXERCISES_CACHE_KEY, JSON.stringify(cache))
}

// Puzzle data ships as a static frontend asset (see vite.config.ts's
// exercisesCatalogPlugin) rather than being downloaded from the backend, so the app
// never needs a backend connection — or an account — just to load puzzles. The
// manifest indirection lets the actual catalog file be cached aggressively (it's
// content-hashed) while still picking up a new export next load (the manifest itself
// is never cached, see public/_headers). Returns null on any failure so callers can
// fall back to the last-known-good cache.
async function fetchPuzzleCatalog(): Promise<PuzzleRow[] | null> {
  try {
    const manifestResponse = await fetch(EXERCISES_MANIFEST_URL)
    if (!manifestResponse.ok) return null
    const manifest = (await manifestResponse.json()) as { file: string }

    const catalogResponse = await fetch(manifest.file)
    if (!catalogResponse.ok) return null
    const catalog = (await catalogResponse.json()) as Record<string, RawExercise[]>
    return flattenCatalog(catalog)
  } catch {
    return null
  }
}

// Inverts backend/scripts/seed_puzzles.mjs's grouping of exercises.json by category path.
function flattenCatalog(catalog: Record<string, RawExercise[]>): PuzzleRow[] {
  const puzzles: PuzzleRow[] = []
  for (const [path, exercises] of Object.entries(catalog)) {
    const categoryPath = path.startsWith('/') ? path.slice(1) : path
    for (const exercise of exercises) {
      puzzles.push({
        id: exercise.fen.replaceAll('_', ' '),
        category_path: categoryPath,
        expected_result: exercise.expected_result,
        current_elo: Number(exercise.difficulty),
      })
    }
  }
  return puzzles
}

function buildExercises(puzzles: PuzzleRow[]): Exercise[] {
  return puzzles.map((puzzle): Exercise => {
    const categoryPath = extractCategoryPath(puzzle.category_path)
    return {
      id: puzzle.id,
      path: puzzle.category_path,
      categoryPath,
      categoryFullPath: categoryPath.join('/'),
      category: categoryPath[0] ?? '',
      subcategory: categoryPath[1] ?? null,
      fen: puzzle.id,
      difficulty: String(puzzle.current_elo),
      expectedResult: puzzle.expected_result,
    }
  })
}

// Puzzle Elo is learned server-side but only reaches clients through the bundled
// exercises.json catalog, refreshed periodically via backend/scripts/export_puzzles.mjs.
function eloOf(exercise: Exercise): number {
  return parseInt(exercise.difficulty)
}

function filterByCategory(exercises: Exercise[], prefix: string | null): Exercise[] {
  if (prefix === null) return exercises
  return exercises.filter(
    (ex) => ex.categoryFullPath === prefix || ex.categoryFullPath.startsWith(`${prefix}/`),
  )
}

// Selects the puzzles eligible under the 'around' preference: everything within +/-ELO_BAND of
// userElo, falling back to the CLOSEST_PUZZLE_COUNT nearest puzzles on a side when that side's
// band is too sparse (e.g. the puzzle pool is clustered far from the user's elo). Puzzles
// exactly at userElo count as "above" so they're never double-counted. Also used by
// 'aroundAndAbove' / 'aroundAndBelow' to backfill their unbounded side with the nearest puzzles
// when the +/-ELO_BAND band on the bounded side is too sparse.
function selectAroundBandIds(exercises: Exercise[], userElo: number): Set<string> {
  const above = exercises.filter((ex) => eloOf(ex) >= userElo)
  const inBandAbove = above.filter((ex) => eloOf(ex) <= userElo + ELO_BAND)
  const aboveSelection =
    inBandAbove.length >= CLOSEST_PUZZLE_COUNT
      ? inBandAbove
      : [...above].sort((a, b) => eloOf(a) - eloOf(b)).slice(0, CLOSEST_PUZZLE_COUNT)

  const below = exercises.filter((ex) => eloOf(ex) < userElo)
  const inBandBelow = below.filter((ex) => eloOf(ex) >= userElo - ELO_BAND)
  const belowSelection =
    inBandBelow.length >= CLOSEST_PUZZLE_COUNT
      ? inBandBelow
      : [...below].sort((a, b) => eloOf(b) - eloOf(a)).slice(0, CLOSEST_PUZZLE_COUNT)

  return new Set([...aboveSelection, ...belowSelection].map((ex) => ex.id))
}

function countPiecesInFen(fen: string): number {
  return (fen.split(' ')[0] ?? '').split('').filter((c) => /[a-zA-Z]/.test(c)).length
}

// Rewrites any legacy `${path}::${fen}` ids to the new normalized-FEN id scheme.
// Idempotent (see migrateLegacyExerciseId), so it's safe to run on every load.
function loadSolvedExercises(): Map<string, string> {
  try {
    const raw = localStorage.getItem('solvedExercises')
    if (!raw) return new Map()
    const obj = JSON.parse(raw) as Record<string, string>

    let migrated = false
    const solved = new Map<string, string>()
    for (const [id, timestamp] of Object.entries(obj)) {
      const newId = migrateLegacyExerciseId(id)
      if (newId !== id) migrated = true
      solved.set(newId, timestamp)
    }

    if (migrated) {
      localStorage.setItem('solvedExercises', JSON.stringify(Object.fromEntries(solved)))
    }
    return solved
  } catch {
    return new Map()
  }
}

function loadSelectedCategory(): string | null {
  try {
    return localStorage.getItem('selectedCategory')
  } catch {
    return null
  }
}

export const useExercisesStore = defineStore('exercises', () => {
  const allExercises = ref<Exercise[]>([])
  const solvedExercises = ref(loadSolvedExercises())
  const currentExerciseId = ref<string | null>(null)
  const currentTransformedFen = ref<string | null>(null)
  const currentTransformCode = ref<string>('')
  const selectedCategory = ref<string | null>(loadSelectedCategory())
  const isLoading = ref(true)
  const initialPieceCount = ref<number | null>(null)
  // True when the URL requested a specific puzzle (?puzzle=<fen>) that doesn't exist in
  // the catalog — shown as an "unknown puzzle" state instead of silently picking a random one.
  const requestedPuzzleNotFound = ref(false)

  // Renders instantly from the localStorage cache if present (so the app works fully
  // offline after the first successful load and never blocks on a fetch), then always
  // fetches the static catalog in the background to pick up a newer export — cheap
  // since the manifest indirection means this is usually a fast, aggressively cached
  // network round trip rather than a real download (see fetchPuzzleCatalog).
  async function load(initialFen?: string): Promise<void> {
    const requestedId = initialFen?.replaceAll('_', ' ') ?? null
    const cache = loadExercisesCache()
    if (cache) {
      allExercises.value = buildExercises(cache.puzzles)
      isLoading.value = false
      selectInitial(requestedId)
      void refreshExerciseCatalog(requestedId)
      return
    }

    await refreshExerciseCatalog(requestedId)
    isLoading.value = false
  }

  function selectInitial(requestedId: string | null): void {
    if (requestedId) {
      requestedPuzzleNotFound.value = !selectById(requestedId)
    } else {
      selectRandom()
    }
  }

  async function refreshExerciseCatalog(requestedId: string | null = null): Promise<void> {
    const puzzles = await fetchPuzzleCatalog()
    if (!puzzles) return

    persistExercisesCache({ puzzles })
    allExercises.value = buildExercises(puzzles)

    if (currentExerciseId.value === null) {
      // Retry a not-yet-found requested puzzle against the fresh catalog before
      // giving up on it; a still-unknown id keeps the "unknown puzzle" state.
      if (requestedId && selectById(requestedId)) {
        requestedPuzzleNotFound.value = false
      } else if (!requestedPuzzleNotFound.value) {
        selectRandom()
      }
      return
    }

    // A background refresh must never swap out the puzzle already on the board
    // (it may have been opened via a shared link, or be mid-solve); only re-roll
    // if it no longer exists in the fresh catalog at all.
    if (currentExercise.value === null) selectRandom()
  }

  // Hard filter applied over the entire exercise pool, before category selection, based on the
  // user's difficultyPreference. The category dropdown, progress counts, and puzzle selection
  // all derive from this, so they stay consistent with each other.
  const difficultyEligibleExercises = computed((): Exercise[] => {
    const profile = useUserProfileStore().profile
    const userElo = profile?.endgameElo ?? 1400
    const preference = profile?.difficultyPreference ?? 'around'

    switch (preference) {
      case 'all':
        return allExercises.value
      case 'aroundAndAbove': {
        const eligibleIds = selectAroundBandIds(allExercises.value, userElo)
        return allExercises.value.filter(
          (ex) => eloOf(ex) >= userElo - ELO_BAND || eligibleIds.has(ex.id),
        )
      }
      case 'aroundAndBelow': {
        const eligibleIds = selectAroundBandIds(allExercises.value, userElo)
        return allExercises.value.filter(
          (ex) => eloOf(ex) <= userElo + ELO_BAND || eligibleIds.has(ex.id),
        )
      }
      case 'around': {
        const eligibleIds = selectAroundBandIds(allExercises.value, userElo)
        return allExercises.value.filter((ex) => eligibleIds.has(ex.id))
      }
    }
  })

  const difficultyEligibleIds = computed(
    (): Set<string> => new Set(difficultyEligibleExercises.value.map((ex) => ex.id)),
  )

  // Exercise ids that have at least one failed attempt, ever (all-time, not just the
  // recent-exclusion window). An id here that's since been solved no longer counts as "failed".
  const everFailedIds = computed((): Set<string> => {
    const history = useUserProfileStore().profile?.eloHistory ?? []
    const ids = new Set<string>()
    for (const entry of history) {
      if (entry.exerciseId && entry.solved === false) ids.add(entry.exerciseId)
    }
    return ids
  })

  function solveStatusOf(exerciseId: string): 'solved' | 'failed' | null {
    if (solvedExercises.value.has(exerciseId)) return 'solved'
    if (everFailedIds.value.has(exerciseId)) return 'failed'
    return null
  }

  // Progress totals cover every difficulty-eligible puzzle plus already-attempted puzzles
  // that have since left the eligible pool (e.g. because the user's elo moved) — an attempt
  // stays visible in the progress counts even once its puzzle is filtered out.
  function countsTowardProgress(exerciseId: string): boolean {
    return difficultyEligibleIds.value.has(exerciseId) || solveStatusOf(exerciseId) !== null
  }

  // Builds the category tree from exercise paths, then flattens it depth-first for the
  // dropdown. Top-level categories are sorted alphabetically (matching prior behaviour);
  // deeper levels preserve the curriculum order from exercises.json. Categories without
  // a single puzzle counting toward progress are omitted.
  const categoryOptions = computed((): CategoryOption[] => {
    interface TreeNode {
      label: string
      value: string
      attempted: number
      total: number
      children: Map<string, TreeNode>
    }

    const roots = new Map<string, TreeNode>()
    for (const ex of allExercises.value) {
      if (!countsTowardProgress(ex.id)) continue
      let siblings = roots
      let prefix = ''
      const attempted = solveStatusOf(ex.id) !== null
      for (const segment of ex.categoryPath) {
        prefix = prefix ? `${prefix}/${segment}` : segment
        let node = siblings.get(segment)
        if (!node) {
          node = { label: segment, value: prefix, attempted: 0, total: 0, children: new Map() }
          siblings.set(segment, node)
        }
        node.total++
        if (attempted) node.attempted++
        siblings = node.children
      }
    }

    function flatten(nodes: Map<string, TreeNode>, depth: number): CategoryOption[] {
      const ordered =
        depth === 0
          ? [...nodes.values()].sort((a, b) => a.label.localeCompare(b.label))
          : [...nodes.values()]
      return ordered.flatMap((node) => [
        {
          label: node.label,
          value: node.value,
          depth,
          attempted: node.attempted,
          total: node.total,
        },
        ...flatten(node.children, depth + 1),
      ])
    }

    return flatten(roots, 0)
  })

  // Exercises in the selected category after the difficulty filter, uncapped — the denominator
  // for solve progress.
  const categoryExercises = computed((): Exercise[] =>
    filterByCategory(difficultyEligibleExercises.value, selectedCategory.value),
  )

  // Same as categoryExercises, but ignoring the difficulty filter — used to work out how many
  // puzzles in the category are hidden by it, and why.
  const categoryExercisesAllDifficulties = computed((): Exercise[] =>
    filterByCategory(allExercises.value, selectedCategory.value),
  )

  // Puzzles hidden from the selected category by the difficulty filter, split by whether
  // they're too hard or too easy relative to the user's current elo.
  const categoryHiddenCounts = computed((): { tooHard: number; tooEasy: number } => {
    const userElo = useUserProfileStore().profile?.endgameElo ?? 1400
    const eligibleIds = difficultyEligibleIds.value

    let tooHard = 0
    let tooEasy = 0
    for (const ex of categoryExercisesAllDifficulties.value) {
      if (eligibleIds.has(ex.id)) continue
      if (eloOf(ex) > userElo) tooHard++
      else if (eloOf(ex) < userElo) tooEasy++
    }
    return { tooHard, tooEasy }
  })

  // Active (eligible) puzzle count for the entire pool, plus how many are hidden by the
  // difficulty filter, split by whether they're too hard or too easy relative to the user's
  // current elo. Used by the difficulty preference settings, which aren't scoped to a category.
  const difficultyPuzzleCounts = computed(
    (): { active: number; tooHard: number; tooEasy: number } => {
      const userElo = useUserProfileStore().profile?.endgameElo ?? 1400
      const eligibleIds = difficultyEligibleIds.value

      let tooHard = 0
      let tooEasy = 0
      for (const ex of allExercises.value) {
        if (eligibleIds.has(ex.id)) continue
        if (eloOf(ex) > userElo) tooHard++
        else if (eloOf(ex) < userElo) tooEasy++
      }
      return { active: eligibleIds.size, tooHard, tooEasy }
    },
  )

  // Exercises within the selected category that are eligible to be picked next: attempted
  // (solved or failed) more than RECENT_ATTEMPT_EXCLUSION_MS ago, or never attempted at all.
  const recentlyAttemptedIds = computed((): Set<string> => {
    const history = useUserProfileStore().profile?.eloHistory ?? []
    const cutoff = Date.now() - RECENT_ATTEMPT_EXCLUSION_MS
    const ids = new Set<string>()
    for (const entry of history) {
      if (!entry.exerciseId) continue
      if (new Date(entry.timestamp).getTime() >= cutoff) ids.add(entry.exerciseId)
    }
    return ids
  })

  const filteredExercises = computed((): Exercise[] => {
    const userElo = useUserProfileStore().profile?.endgameElo ?? 1400

    const pool = categoryExercises.value.filter((ex) => !recentlyAttemptedIds.value.has(ex.id))

    return pool
      .map((ex) => ({ ex, dist: Math.abs(parseInt(ex.difficulty) - userElo) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 100)
      .map(({ ex }) => ex)
  })

  const currentExercise = computed((): Exercise | null => {
    if (!currentExerciseId.value) return null
    return allExercises.value.find((ex) => ex.id === currentExerciseId.value) ?? null
  })

  // The selected category's progress pool — see countsTowardProgress for why this is not
  // simply categoryExercises.
  const countedCategoryExercises = computed((): Exercise[] =>
    categoryExercisesAllDifficulties.value.filter((ex) => countsTowardProgress(ex.id)),
  )

  const categoryPuzzleTotal = computed((): number => countedCategoryExercises.value.length)

  const categoryPuzzleSolved = computed(
    (): number =>
      countedCategoryExercises.value.filter((ex) => solveStatusOf(ex.id) === 'solved').length,
  )

  const categoryPuzzleFailed = computed(
    (): number =>
      countedCategoryExercises.value.filter((ex) => solveStatusOf(ex.id) === 'failed').length,
  )

  const categoryPuzzleUnattempted = computed(
    (): number =>
      categoryPuzzleTotal.value - categoryPuzzleSolved.value - categoryPuzzleFailed.value,
  )

  // Builds the full category tree with per-node solve counts (aggregated over descendants),
  // pruning any node without a single attempted puzzle. Mirrors the categoryOptions
  // tree-building logic.
  const categoryProgressTree = computed((): CategoryProgressNode[] => {
    interface TreeNode {
      label: string
      value: string
      total: number
      solved: number
      failed: number
      hidden: number
      children: Map<string, TreeNode>
    }

    const roots = new Map<string, TreeNode>()
    for (const ex of allExercises.value) {
      let siblings = roots
      let prefix = ''
      const counted = countsTowardProgress(ex.id)
      const status = solveStatusOf(ex.id)
      for (const segment of ex.categoryPath) {
        prefix = prefix ? `${prefix}/${segment}` : segment
        let node = siblings.get(segment)
        if (!node) {
          node = {
            label: segment,
            value: prefix,
            total: 0,
            solved: 0,
            failed: 0,
            hidden: 0,
            children: new Map(),
          }
          siblings.set(segment, node)
        }
        if (counted) {
          node.total++
          if (status === 'solved') node.solved++
          else if (status === 'failed') node.failed++
        } else {
          node.hidden++
        }
        siblings = node.children
      }
    }

    function build(nodes: Map<string, TreeNode>, depth: number): CategoryProgressNode[] {
      const ordered =
        depth === 0
          ? [...nodes.values()].sort((a, b) => a.label.localeCompare(b.label))
          : [...nodes.values()]
      return ordered
        .filter((node) => node.solved > 0 || node.failed > 0)
        .map((node) => ({
          label: node.label,
          value: node.value,
          depth,
          solved: node.solved,
          failed: node.failed,
          unattempted: node.total - node.solved - node.failed,
          total: node.total,
          hidden: node.hidden,
          children: build(node.children, depth + 1),
        }))
    }

    return build(roots, 0)
  })

  // Solve progress over the whole pool (see countsTowardProgress), regardless of the
  // selected category.
  const overallProgress = computed((): SolveProgress => {
    let solved = 0
    let failed = 0
    let total = 0
    let hidden = 0
    for (const ex of allExercises.value) {
      if (!countsTowardProgress(ex.id)) {
        hidden++
        continue
      }
      total++
      const status = solveStatusOf(ex.id)
      if (status === 'solved') solved++
      else if (status === 'failed') failed++
    }
    return { solved, failed, unattempted: total - solved - failed, total, hidden }
  })

  function selectRandom(eloOverride?: number): void {
    requestedPuzzleNotFound.value = false
    const userElo = eloOverride ?? useUserProfileStore().profile?.endgameElo ?? 1400

    const pool = filteredExercises.value
    if (pool.length === 0) {
      currentExerciseId.value = null
      initialPieceCount.value = null
      return
    }

    const weights = pool.map((ex) => {
      const delta = Math.abs(userElo - parseInt(ex.difficulty))
      return 1 / (1 + 10 ** (delta / 100))
    })
    const totalWeight = weights.reduce((sum, w) => sum + w, 0)
    let rand = Math.random() * totalWeight
    let chosen = pool[pool.length - 1]
    for (let i = 0; i < pool.length; i++) {
      rand -= weights[i] ?? 0
      if (rand <= 0) {
        chosen = pool[i] ?? chosen
        break
      }
    }

    if (chosen) {
      const code = pickRandomTransformCode(chosen.fen)
      currentTransformCode.value = code
      currentTransformedFen.value = applyTransformCode(chosen.fen, code)
      currentExerciseId.value = chosen.id
      initialPieceCount.value = countPiecesInFen(chosen.fen)
    }
  }

  function recordSolved(): void {
    const id = currentExerciseId.value
    const exercise = currentExercise.value
    if (!id || !exercise) return

    solvedExercises.value.set(id, new Date().toISOString())
    localStorage.setItem(
      'solvedExercises',
      JSON.stringify(Object.fromEntries(solvedExercises.value)),
    )

    useUserProfileStore().recordResult(eloOf(exercise), true, currentTransformCode.value, id)
  }

  function recordFailed(): void {
    const id = currentExerciseId.value
    const exercise = currentExercise.value
    if (!exercise || !id) return
    useUserProfileStore().recordResult(eloOf(exercise), false, currentTransformCode.value, id)
  }

  // Cloud wins on login, but never in a way that can un-solve a puzzle this device
  // already knows about: remote solves are merged into (not replacing) the local set.
  function rebuildFromRemoteAttempts(attempts: Tables<'attempts'>[]): void {
    const merged = new Map(solvedExercises.value)
    for (const attempt of attempts) {
      if (!attempt.solved || !attempt.puzzle_id) continue
      const existing = merged.get(attempt.puzzle_id)
      if (!existing || attempt.attempted_at > existing) {
        merged.set(attempt.puzzle_id, attempt.attempted_at)
      }
    }
    solvedExercises.value = merged
    localStorage.setItem('solvedExercises', JSON.stringify(Object.fromEntries(merged)))
  }

  // Selects an exercise by id (its original fen) and rolls a fresh random
  // transformation for it. Returns false if no such exercise exists.
  function selectById(id: string): boolean {
    const exercise = allExercises.value.find((ex) => ex.id === id)
    if (!exercise) return false
    requestedPuzzleNotFound.value = false
    const code = pickRandomTransformCode(exercise.fen)
    currentTransformCode.value = code
    currentTransformedFen.value = applyTransformCode(exercise.fen, code)
    currentExerciseId.value = id
    initialPieceCount.value = countPiecesInFen(exercise.fen)
    return true
  }

  // Selects an exercise by id and applies a specific, already-known transform
  // code rather than rolling a new one — used to replay a puzzle exactly as it
  // appeared in the user's history. Returns false if no such exercise exists.
  function selectByIdWithTransform(id: string, code: string): boolean {
    const exercise = allExercises.value.find((ex) => ex.id === id)
    if (!exercise) return false
    requestedPuzzleNotFound.value = false
    currentTransformCode.value = code
    currentTransformedFen.value = applyTransformCode(exercise.fen, code)
    currentExerciseId.value = id
    initialPieceCount.value = countPiecesInFen(exercise.fen)
    return true
  }

  function advanceToNext(): void {
    selectRandom()
  }

  // Used by SetupModal to preview an appropriately-difficulty puzzle behind the modal
  // as the user picks a starting Elo, before any profile exists to read Elo from.
  function previewExerciseForElo(elo: number): void {
    selectRandom(elo)
  }

  // Re-rolls the current exercise if it's fallen outside the eligible pool, e.g. after the
  // category or difficulty preference changes.
  function reselectIfCurrentInvalid(): void {
    const current = currentExercise.value
    const stillValid =
      current !== null && filteredExercises.value.some((ex) => ex.id === current.id)
    if (!stillValid) {
      selectRandom()
    }
  }

  function setCategory(cat: string | null): void {
    selectedCategory.value = cat
    if (cat === null) {
      localStorage.removeItem('selectedCategory')
    } else {
      localStorage.setItem('selectedCategory', cat)
    }
    reselectIfCurrentInvalid()
  }

  function onDifficultyPreferenceChanged(): void {
    reselectIfCurrentInvalid()
  }

  return {
    isLoading,
    categoryOptions,
    categoryExercises,
    filteredExercises,
    currentExercise,
    currentTransformedFen,
    currentTransformCode,
    requestedPuzzleNotFound,
    categoryPuzzleTotal,
    categoryPuzzleSolved,
    categoryPuzzleFailed,
    categoryPuzzleUnattempted,
    categoryHiddenCounts,
    difficultyPuzzleCounts,
    categoryProgressTree,
    overallProgress,
    selectedCategory,
    initialPieceCount,
    load,
    recordSolved,
    recordFailed,
    selectById,
    selectByIdWithTransform,
    advanceToNext,
    previewExerciseForElo,
    setCategory,
    onDifficultyPreferenceChanged,
    rebuildFromRemoteAttempts,
  }
})
