import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useUserProfileStore } from '@/stores/userProfile'
import {
  allTransformedFens,
  applyTransformCode,
  findTransformCode,
  pickRandomTransformCode,
} from '@/utils/fenTransform'
import { migrateLegacyExerciseId } from '@/utils/exerciseId'
import { categorySegmentLabel } from '@/utils/categoryLabels'
import { RECENT_ATTEMPT_EXCLUSION_MS } from '@/utils/attemptWindow'
import type { Tables } from '@/types/database'

interface PuzzleRow {
  id: string
  category_path: string
  expected_result: string
  current_elo: number
  tags?: string[]
}

interface RawExercise {
  fen: string
  expected_result: string
  difficulty: string | number
  tags?: string[]
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
  // Themes the puzzle illustrates (opposition, breakthrough, …). Free-form and
  // many-per-puzzle, unlike the category, which is one material relation per puzzle.
  tags: string[]
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

// Why the selected category currently has no puzzle to offer:
// - `allCompleted`: every puzzle in it has been attempted within the recent-attempt window,
//   whatever the difficulty preference (see recentAttemptStatusById).
// - `restHiddenByDifficulty`: uncompleted ones remain, but the difficulty preference hides them.
// - `noExercises`: the category holds no puzzles at all.
export type CategoryEmptyReason = 'allCompleted' | 'restHiddenByDifficulty' | 'noExercises'

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

// The +/- elo range used by the 'around' difficulty preference, and the floor/ceiling offset
// for 'aroundAndAbove' / 'aroundAndBelow'. Also the band used by puzzleDifficultyColor.ts to
// color-code puzzles in the Browse Exercises page relative to the user's elo.
export const ELO_BAND = 200

// Elo assumed while no profile exists yet — matches the setup wizard's default starting level,
// which is also what the teaser puzzle behind the setup modal is rolled for.
const DEFAULT_ELO = 1400

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
  // No point starting a request known to fail — this skips a network round trip that
  // would otherwise sit and wait for the browser to notice there's no connection
  // (which can take much longer than an immediately-rejected offline fetch would).
  if (!navigator.onLine) return null
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
        tags: exercise.tags,
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
      tags: puzzle.tags ?? [],
    }
  })
}

// Puzzle Elo is learned server-side but only reaches clients through the bundled
// exercises.json catalog, refreshed periodically via backend/scripts/export_puzzles.mjs.
function eloOf(exercise: Exercise): number {
  return parseInt(exercise.difficulty)
}

interface CategoryTreeNode {
  label: string
  value: string
  attempted: number
  total: number
  children: Map<string, CategoryTreeNode>
}

// Groups exercises into a category tree by their categoryPath segments. `isAttempted`
// decides whether a given exercise counts toward a node's `attempted` count.
function buildCategoryTreeNodes(
  exercises: Exercise[],
  isAttempted: (exerciseId: string) => boolean,
): Map<string, CategoryTreeNode> {
  const roots = new Map<string, CategoryTreeNode>()
  for (const ex of exercises) {
    let siblings = roots
    let prefix = ''
    const attempted = isAttempted(ex.id)
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
  return roots
}

// Flattens a category tree depth-first, preserving the curriculum order of exercises.json at
// every level — including the top one, which used to be sorted alphabetically: the material
// relations it now holds are written in figurine notation ("♖ vs ♝"), whose sort order says
// nothing about anything, while the file lists them easiest-first.
function flattenCategoryTree(
  nodes: Map<string, CategoryTreeNode>,
  depth: number,
): CategoryOption[] {
  return [...nodes.values()].flatMap((node) => [
    {
      label: categorySegmentLabel(node.label),
      value: node.value,
      depth,
      attempted: node.attempted,
      total: node.total,
    },
    ...flattenCategoryTree(node.children, depth + 1),
  ])
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

// The catalog was reorganised around material relations ("♖ vs ♝") instead of the scrape's
// original chapter names, so a category persisted before that would now select nothing.
// Longest prefix wins, and subcategories ride along on their parent's prefix.
const RENAMED_CATEGORY_PREFIXES: [oldPrefix: string, newPrefix: string][] = [
  ['Basic Endgames', 'Pure Pieces Endgames'],
  ['Bishop+Knight vs King', 'Pure Pieces Endgames/♔♗♘ vs ♚'],
  ['Rook+Bishop vs Rook', 'Pure Pieces Endgames/♔♖♗ vs ♚♜'],
  ['Queen vs Rook/Only', 'Pure Pieces Endgames/♔♕ vs ♚♜'],
  ['Queen vs Rook/And Pawns', '♕ vs ♜'],
  ['Queen vs Rook', '♕ vs ♜'],
  ['Queen Endgames', '♕ vs ♛'],
  ['Knight vs Pawns', '♘ vs Pawns'],
  ['Knights Endgames', '♘ vs ♞'],
  ['Bishop vs Pawns', '♗ vs Pawns'],
  ['Bishop vs Knight', '♗ vs ♞'],
  ['Opposite-Colored Bishops', '♗ vs ♝/Opposite Colour'],
  ['Same Color Bishops', '♗ vs ♝/Same Colour'],
  ['Rook vs Pawns', '♖ vs Pawns'],
  ['Rook Endgames', '♖ vs ♜'],
  ['Rook vs Knight', '♖ vs ♞'],
  ['Rook vs Bishop & Multiple Pawns', '♖ vs ♝'],
  ['Rook vs Bishop', '♖ vs ♝'],
]

function migrateRenamedCategory(category: string): string {
  for (const [oldPrefix, newPrefix] of RENAMED_CATEGORY_PREFIXES) {
    if (category === oldPrefix) return newPrefix
    if (category.startsWith(`${oldPrefix}/`)) {
      return newPrefix + category.slice(oldPrefix.length)
    }
  }
  return category
}

function loadSelectedCategory(): string | null {
  try {
    const stored = localStorage.getItem('selectedCategory')
    if (stored === null) return null
    const migrated = migrateRenamedCategory(stored)
    if (migrated !== stored) localStorage.setItem('selectedCategory', migrated)
    return migrated
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
  // Whether the current puzzle was asked for by id (a shared link, puzzle history, a restored
  // session) rather than rolled at random. Such a puzzle is never swapped out behind the user's
  // back — see reselectAfterRemoteEloChange.
  const isCurrentExerciseExplicitlySelected = ref(false)
  // The starting level the setup wizard is currently showing, standing in for the profile elo
  // until one exists — see effectiveUserElo. Stays set afterwards but stops mattering: the
  // profile the wizard creates carries the same elo and takes precedence over it.
  const previewElo = ref<number | null>(null)

  // Exercise ids are their (untransformed) fens, looked up on every puzzle selection and
  // once per candidate transformation when resolving a fen from a URL — often enough over
  // a catalog of thousands to be worth indexing rather than scanning.
  const exercisesById = computed(
    (): Map<string, Exercise> => new Map(allExercises.value.map((ex) => [ex.id, ex])),
  )

  // Renders instantly from the localStorage cache if present (so the app works fully
  // offline after the first successful load and never blocks on a fetch), then always
  // fetches the static catalog in the background to pick up a newer export — cheap
  // since the manifest indirection means this is usually a fast, aggressively cached
  // network round trip rather than a real download (see fetchPuzzleCatalog).
  async function load(initialFen?: string): Promise<void> {
    const requestedFen = initialFen?.replaceAll('_', ' ') ?? null
    const cache = loadExercisesCache()
    if (cache) {
      allExercises.value = buildExercises(cache.puzzles)
      pruneSelectedCategoryToExisting()
      isLoading.value = false
      selectInitial(requestedFen)
      void refreshExerciseCatalog(requestedFen)
      return
    }

    await refreshExerciseCatalog(requestedFen)
    isLoading.value = false
  }

  // A persisted category can outlive the catalog shape it was picked from: subcategories get
  // merged into their parent, themes turn into tags. Rather than leaving the user staring at
  // a category that no longer holds anything, fall back to the nearest ancestor that does —
  // ultimately "all categories". Callers pick a puzzle right afterwards, so this deliberately
  // doesn't go through setCategory (whose re-roll would be thrown away).
  function pruneSelectedCategoryToExisting(): void {
    let candidate = selectedCategory.value
    while (candidate !== null && filterByCategory(allExercises.value, candidate).length === 0) {
      const parentEnd = candidate.lastIndexOf('/')
      candidate = parentEnd === -1 ? null : candidate.slice(0, parentEnd)
    }
    if (candidate === selectedCategory.value) return
    selectedCategory.value = candidate
    if (candidate === null) localStorage.removeItem('selectedCategory')
    else localStorage.setItem('selectedCategory', candidate)
  }

  function selectInitial(requestedFen: string | null): void {
    if (requestedFen) {
      requestedPuzzleNotFound.value = !selectByTransformedFen(requestedFen)
    } else {
      selectRandom()
    }
  }

  async function refreshExerciseCatalog(requestedFen: string | null = null): Promise<void> {
    const puzzles = await fetchPuzzleCatalog()
    if (!puzzles) return

    persistExercisesCache({ puzzles })
    allExercises.value = buildExercises(puzzles)
    pruneSelectedCategoryToExisting()

    if (currentExerciseId.value === null) {
      // Retry a not-yet-found requested puzzle against the fresh catalog before
      // giving up on it; a still-unknown fen keeps the "unknown puzzle" state.
      if (requestedFen && selectByTransformedFen(requestedFen)) {
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

  // The puzzles the 'around' difficulty preference would select, regardless of the user's
  // actual preference — also the Browse Exercises page's "around my level" filter.
  const aroundLevelExerciseIds = computed(
    (): Set<string> => selectAroundBandIds(allExercises.value, effectiveUserElo()),
  )

  // The elo puzzle selection is scoped to: the profile's, or — before one exists — whatever the
  // setup wizard's starting-level slider currently sits at, so the teaser puzzle behind the modal
  // actually matches the level being picked.
  function effectiveUserElo(): number {
    return useUserProfileStore().profile?.endgameElo ?? previewElo.value ?? DEFAULT_ELO
  }

  // Hard filter applied over the entire exercise pool, before category selection, based on the
  // user's difficultyPreference. The category dropdown, progress counts, and puzzle selection
  // all derive from this, so they stay consistent with each other.
  const difficultyEligibleExercises = computed((): Exercise[] => {
    const userElo = effectiveUserElo()
    const preference = useUserProfileStore().profile?.difficultyPreference ?? 'around'

    switch (preference) {
      case 'all':
        return allExercises.value
      case 'aroundAndAbove': {
        const eligibleIds = aroundLevelExerciseIds.value
        return allExercises.value.filter(
          (ex) => eloOf(ex) >= userElo - ELO_BAND || eligibleIds.has(ex.id),
        )
      }
      case 'aroundAndBelow': {
        const eligibleIds = aroundLevelExerciseIds.value
        return allExercises.value.filter(
          (ex) => eloOf(ex) <= userElo + ELO_BAND || eligibleIds.has(ex.id),
        )
      }
      case 'around': {
        const eligibleIds = aroundLevelExerciseIds.value
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
  // dropdown, in the curriculum order of exercises.json. Shared by categoryOptions
  // (progress-filtered pool) and catalogCategoryOptions (entire catalog).
  const categoryOptions = computed((): CategoryOption[] =>
    flattenCategoryTree(
      buildCategoryTreeNodes(
        allExercises.value.filter((ex) => countsTowardProgress(ex.id)),
        (id) => solveStatusOf(id) !== null,
      ),
      0,
    ),
  )

  // Same shape as categoryOptions, but over the catalog exercises matching `matches`,
  // regardless of difficulty preference or attempt history — the category list for the
  // Browse Exercises page, whose own filters decide what matches. Categories left without
  // a single matching puzzle are omitted entirely. `attempted` is always 0 here (unused
  // by that page).
  function catalogCategoryOptionsMatching(matches: (exercise: Exercise) => boolean) {
    return flattenCategoryTree(
      buildCategoryTreeNodes(allExercises.value.filter(matches), () => false),
      0,
    )
  }

  const catalogCategoryOptions = computed((): CategoryOption[] =>
    catalogCategoryOptionsMatching(() => true),
  )

  // Exercises in `value`'s category (including descendants), across the entire catalog
  // regardless of difficulty preference, sorted easy-to-hard. Used by Browse Exercises.
  function puzzlesInCategory(value: string): Exercise[] {
    return [...filterByCategory(allExercises.value, value)].sort((a, b) => eloOf(a) - eloOf(b))
  }

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

  // Active (eligible) puzzle count for the entire pool, plus how many are hidden by the
  // difficulty filter, split by whether they're too hard or too easy relative to the user's
  // current elo. Used by the difficulty preference settings, which aren't scoped to a category.
  const difficultyPuzzleCounts = computed(
    (): { active: number; tooHard: number; tooEasy: number } => {
      const userElo = effectiveUserElo()
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

  // The outcome of each exercise's most recent attempt within the recent-attempt window — the
  // "last 8 weeks" of puzzle history the app works with everywhere. An exercise in here counts
  // as *completed*: it stays out of the selection pool until its attempt ages out of the
  // window, after which the puzzle comes around again and is uncompleted once more.
  const recentAttemptStatusById = computed((): Map<string, 'solved' | 'failed'> => {
    const history = useUserProfileStore().profile?.eloHistory ?? []
    const cutoff = Date.now() - RECENT_ATTEMPT_EXCLUSION_MS
    const statuses = new Map<string, 'solved' | 'failed'>()
    for (const entry of history) {
      if (!entry.exerciseId) continue
      if (new Date(entry.timestamp).getTime() < cutoff) continue
      statuses.set(entry.exerciseId, entry.solved ? 'solved' : 'failed')
    }
    return statuses
  })

  const completedExerciseIds = computed(
    (): Set<string> => new Set(recentAttemptStatusById.value.keys()),
  )

  // Puzzles hidden from the selected category by the difficulty filter that the user has not
  // completed, split by whether they're too hard or too easy relative to the user's current
  // elo — i.e. exactly the puzzles that widening the difficulty preference would put back on
  // the board. Already-completed ones are left out: unlocking them would offer nothing new,
  // since they stay out of the pool until their attempt ages out anyway.
  const categoryHiddenUncompletedCounts = computed((): { tooHard: number; tooEasy: number } => {
    const userElo = effectiveUserElo()
    const eligibleIds = difficultyEligibleIds.value

    let tooHard = 0
    let tooEasy = 0
    for (const ex of categoryExercisesAllDifficulties.value) {
      if (eligibleIds.has(ex.id) || completedExerciseIds.value.has(ex.id)) continue
      if (eloOf(ex) < userElo) tooEasy++
      else tooHard++
    }
    return { tooHard, tooEasy }
  })

  // Why there is no puzzle left to put on the board in the selected category. Only meaningful
  // while currentExercise is null — the training view picks which "nothing to solve" message
  // to show from it. Deliberately judged against the whole category (every difficulty), so
  // completing it always reads as a celebration rather than as an empty filter.
  const categoryEmptyReason = computed((): CategoryEmptyReason => {
    if (categoryExercisesAllDifficulties.value.length === 0) return 'noExercises'
    const hidden = categoryHiddenUncompletedCounts.value
    if (hidden.tooHard > 0 || hidden.tooEasy > 0) return 'restHiddenByDifficulty'
    return 'allCompleted'
  })

  // How many of the selected category's completed puzzles were solved rather than failed, as a
  // percentage — shown with the "category completed" celebration. Null while nothing in the
  // category has been completed.
  const categorySolveRatePercent = computed((): number | null => {
    let completed = 0
    let solved = 0
    for (const ex of categoryExercisesAllDifficulties.value) {
      const status = recentAttemptStatusById.value.get(ex.id)
      if (!status) continue
      completed++
      if (status === 'solved') solved++
    }
    return completed === 0 ? null : Math.round((solved / completed) * 100)
  })

  const filteredExercises = computed((): Exercise[] => {
    const userElo = effectiveUserElo()

    const pool = categoryExercises.value.filter((ex) => !completedExerciseIds.value.has(ex.id))

    return pool
      .map((ex) => ({ ex, dist: Math.abs(parseInt(ex.difficulty) - userElo) }))
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 100)
      .map(({ ex }) => ex)
  })

  const currentExercise = computed((): Exercise | null => {
    if (!currentExerciseId.value) return null
    return exercisesById.value.get(currentExerciseId.value) ?? null
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
      return [...nodes.values()]
        .filter((node) => node.solved > 0 || node.failed > 0)
        .map((node) => ({
          label: categorySegmentLabel(node.label),
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

  function selectRandom(): void {
    requestedPuzzleNotFound.value = false
    isCurrentExerciseExplicitlySelected.value = false
    const userElo = effectiveUserElo()

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

  // Whether exerciseId has a solved attempt within the same recent-attempt window used to
  // keep it out of the random-selection pool (see recentlyAttemptedIds). Used to gate
  // analysis mode: jumping straight into analysis for a puzzle that hasn't actually been
  // solved (recently) would let the player read engine lines and then "solve" it with
  // borrowed knowledge.
  function hasSolvedRecently(exerciseId: string): boolean {
    const history = useUserProfileStore().profile?.eloHistory ?? []
    const cutoff = Date.now() - RECENT_ATTEMPT_EXCLUSION_MS
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i]
      if (!entry) break
      if (new Date(entry.timestamp).getTime() < cutoff) break
      if (entry.exerciseId === exerciseId && entry.solved === true) return true
    }
    return false
  }

  // The exercise's most recent attempt outcome within the recent-attempt window (see
  // recentAttemptStatusById). Used by Browse Exercises to mark puzzles as solved/failed.
  function recentAttemptStatus(exerciseId: string): 'solved' | 'failed' | null {
    return recentAttemptStatusById.value.get(exerciseId) ?? null
  }

  function exerciseById(id: string): Exercise | undefined {
    return exercisesById.value.get(id)
  }

  // A puzzle id (its own history, a shared link, ...) that no longer resolves against the
  // current catalog — e.g. it was fixed/pruned by a later exercises.json export (see
  // backend/scripts/seed_puzzles.mjs). Clears whatever was previously selected and flips
  // requestedPuzzleNotFound rather than leaving the prior puzzle's stale state in place,
  // which would otherwise look like the new puzzle silently loaded in the wrong state.
  function selectNotFound(): void {
    requestedPuzzleNotFound.value = true
    isCurrentExerciseExplicitlySelected.value = true
    currentExerciseId.value = null
    currentTransformedFen.value = null
    initialPieceCount.value = null
  }

  // Recovers the puzzle a *transformed* fen belongs to — the form fens take in URLs, so
  // that everyone following a shared link sees the very same board (see currentUrlFen in
  // TrainingPage). Puzzle identity is the untransformed fen, which is recovered by
  // undoing each candidate transformation in turn until one lands on a known puzzle; no
  // stored mapping of transformed fens is needed. Also resolves an untransformed fen (as
  // links shared before this scheme carry), which comes back with the identity code.
  // A handful of catalog puzzles are mirror images of each other, so a transformed fen can
  // match two of them; the untransformed candidate is tried first, which keeps a puzzle's
  // own fen resolving to itself and makes the tie-break deterministic either way.
  function resolveTransformedFen(
    fen: string,
  ): { exerciseId: string; transformCode: string } | null {
    for (const candidateOriginal of allTransformedFens(fen)) {
      if (!exercisesById.value.has(candidateOriginal)) continue
      const code = findTransformCode(candidateOriginal, fen)
      if (code === null) continue
      return { exerciseId: candidateOriginal, transformCode: code }
    }
    return null
  }

  // Selects the puzzle a URL fen stands for, shown in exactly the orientation that fen
  // asks for rather than a freshly rolled one. Returns false if it matches no puzzle.
  function selectByTransformedFen(fen: string): boolean {
    const resolved = resolveTransformedFen(fen)
    if (!resolved) {
      selectNotFound()
      return false
    }
    return selectByIdWithTransform(resolved.exerciseId, resolved.transformCode)
  }

  // Selects an exercise by id and applies a specific, already-known transform
  // code rather than rolling a new one — used to replay a puzzle exactly as it
  // appeared in the user's history. Returns false if no such exercise exists.
  function selectByIdWithTransform(id: string, code: string): boolean {
    const exercise = exercisesById.value.get(id)
    if (!exercise) {
      selectNotFound()
      return false
    }
    requestedPuzzleNotFound.value = false
    isCurrentExerciseExplicitlySelected.value = true
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
  // as the user picks a starting Elo, before any profile exists to read Elo from. The elo is
  // remembered rather than applied to this roll alone: it has to keep standing in for the
  // profile's until one exists, or the eligible pool the next roll draws from (and everything
  // else derived from it) falls back to DEFAULT_ELO and hands out puzzles for the wrong level.
  function previewExerciseForElo(elo: number): void {
    previewElo.value = elo
    selectRandom()
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

  // The Elo a pulled cloud profile brings can be far from the one the puzzle on the board was
  // rolled for — most visibly right after signing in, where that puzzle is the teaser rolled at
  // the wizard's default starting level while the setup modal was still open. Only a change big
  // enough to move the eligible pool re-rolls, and only if the current puzzle actually fell out
  // of it, so the routine background pulls (which fire on every tab focus, see sync.ts) don't
  // swap out a puzzle for no visible reason. `previousElo` is null when no local profile existed
  // yet — the teaser puzzle was rolled at the wizard's starting level in that case (or
  // DEFAULT_ELO, if the wizard never got as far as offering one).
  function reselectAfterRemoteEloChange(previousElo: number | null): void {
    if (isCurrentExerciseExplicitlySelected.value) return
    if (Math.abs(effectiveUserElo() - (previousElo ?? previewElo.value ?? DEFAULT_ELO)) < ELO_BAND)
      return
    reselectIfCurrentInvalid()
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
    catalogCategoryOptions,
    catalogCategoryOptionsMatching,
    aroundLevelExerciseIds,
    puzzlesInCategory,
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
    categoryHiddenUncompletedCounts,
    categoryEmptyReason,
    categorySolveRatePercent,
    difficultyPuzzleCounts,
    categoryProgressTree,
    overallProgress,
    selectedCategory,
    initialPieceCount,
    load,
    recordSolved,
    recordFailed,
    hasSolvedRecently,
    recentAttemptStatus,
    exerciseById,
    selectByTransformedFen,
    selectByIdWithTransform,
    advanceToNext,
    previewExerciseForElo,
    reselectAfterRemoteEloChange,
    setCategory,
    onDifficultyPreferenceChanged,
    rebuildFromRemoteAttempts,
  }
})
