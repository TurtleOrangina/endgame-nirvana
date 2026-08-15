import path from 'node:path'
import { createSeededRandom } from '@/measurements/shared/puzzleCatalog'
import {
  createWasmStockfishEngine,
  defaultWasmEngineThreads,
} from '@/measurements/shared/wasmStockfishEngine'
import {
  createOfflineTablebaseClient,
  createTablebaseClient,
  type TablebaseClient,
} from '@/measurements/shared/tablebaseClient'
import { NATIVE_STOCKFISH_PATH } from '@/measurements/shared/enginePaths'
import {
  assertStrongEngineLoadedSyzygy,
  createStrongEngine,
  DEFAULT_STRONG_ENGINE_THREADS,
} from './strongEngine'
import { loadOrCreatePuzzleSet, type PlayoutPuzzle } from './playoutPuzzleSelection'
import { playOutPuzzle, strongEngineGoalFailure, type DefenderKind } from './enginePlayout'
import { trimPlayout } from './playoutTrimming'
import type { PuzzleMeasurement } from './report'

export const PUZZLE_SET_FILE = 'engine-playout-puzzles.yaml'

// Each defender writes its own baseline and run-detail file, so runs never overwrite each
// other and can be diffed puzzle by puzzle. The shipped selector takes the unsuffixed name.
const FILE_SUFFIX: Record<DefenderKind, string> = {
  'move-selector': '',
  'engine-best-move': '-engine-best-move',
  offline: '-offline',
}

export function baselineFileFor(defenderKind: DefenderKind): string {
  return `engine-playout-baseline${FILE_SUFFIX[defenderKind]}.yaml`
}

// Every defender is measured to answer the same question — is it better than what ships? —
// so the in-flight comparison is always against the move selector's baseline, not against
// the running defender's own previous run, which would only report engine noise
export const COMPARISON_DEFENDER: DefenderKind = 'move-selector'

export const DEFENDER_KINDS = Object.keys(FILE_SUFFIX) as DefenderKind[]

export interface PlayoutMeasurementConfig {
  frontendRoot: string
  binaryPath: string
  defenderThreads: number
  strongEngineThreads: number
  puzzleCount: number
  playoutsPerPuzzle: number
  seed: number
  resample: boolean
  /** Pick up where an interrupted run of the same configuration left off — see playoutRunStore */
  resumePreviousRun: boolean
  defenderKind: DefenderKind
  minTablebaseRequestIntervalMs?: number
  /**
   * Puzzle set to run, relative to the frontend root. Defaults to the committed
   * `PUZZLE_SET_FILE`. Point it at a smaller hand-built set to measure an effect that only
   * appears in a slice of positions — a full run would drown it in puzzles the change cannot
   * touch. Scores from one puzzle set are never comparable to scores from another.
   */
  puzzleSetFile?: string
}

export const DEFAULT_CONFIG = {
  binaryPath: NATIVE_STOCKFISH_PATH,
  puzzleCount: 64,
  playoutsPerPuzzle: 6,
  seed: 20_260_809,
  resample: false,
  resumePreviousRun: false,
  defenderKind: 'move-selector',
} as const satisfies Partial<PlayoutMeasurementConfig>

export interface StrongEngineFailure {
  fen: string
  goal: string
  run: number
  reason: string
}

export interface PlayoutMeasurementRunner {
  puzzles: PlayoutPuzzle[]
  /**
   * Plays the puzzle out, skipping the first `alreadyMeasured` playouts — that is what a
   * top-up run leans on to add playouts to a puzzle an earlier run already measured. The
   * returned measurement holds only the playouts measured now.
   */
  measurePuzzle(
    puzzle: PlayoutPuzzle,
    index: number,
    alreadyMeasured?: number,
  ): Promise<PuzzleMeasurement>
  tablebase: TablebaseClient
  /** Confirms the user engine really has its tablebases before the run commits an hour to it */
  verifyStrongEngine(): Promise<void>
  /** Every puzzle whose goal the user engine failed to reach — expected to stay empty */
  strongEngineFailures(): readonly StrongEngineFailure[]
  shutDown(): void
}

export function createPlayoutRunner(config: PlayoutMeasurementConfig): PlayoutMeasurementRunner {
  // `offline` is the shipped selector cut off from the tablebase, so it gets a
  // client that fails every request instead of one backed by the cache and the network
  const tablebase =
    config.defenderKind === 'offline'
      ? createOfflineTablebaseClient()
      : createTablebaseClient(
          path.join(config.frontendRoot, '.tablebase-cache'),
          config.minTablebaseRequestIntervalMs,
        )
  tablebase.installFetchInterception()

  const defenderEngine = createWasmStockfishEngine(config.frontendRoot, config.defenderThreads)
  const strongEngine = createStrongEngine(config.binaryPath, config.strongEngineThreads)

  const strongEngineFailures: StrongEngineFailure[] = []

  const puzzles = loadOrCreatePuzzleSet(
    path.join(config.frontendRoot, config.puzzleSetFile ?? PUZZLE_SET_FILE),
    path.join(config.frontendRoot, 'public', 'exercises.json'),
    config.seed,
    config.puzzleCount,
    config.resample,
  )

  async function measurePuzzle(
    puzzle: PlayoutPuzzle,
    index: number,
    alreadyMeasured = 0,
  ): Promise<PuzzleMeasurement> {
    const playouts: PuzzleMeasurement['playouts'] = []
    // Starting at the run number the earlier playouts stopped at, so a top-up seeds its
    // playouts differently from the ones already on disk rather than repeating their sampling
    for (let run = alreadyMeasured; run < config.playoutsPerPuzzle; run++) {
      // The selector samples its moves with Math.random; seeding it per playout keeps the
      // run reproducible while still letting the two playouts of a puzzle differ
      const originalRandom = Math.random
      Math.random = createSeededRandom(config.seed + index * 7919 + run)
      try {
        const playout = await playOutPuzzle({
          puzzle,
          defenderEngine,
          strongEngine,
          tablebase,
          defenderKind: config.defenderKind,
        })
        const goalFailure = strongEngineGoalFailure(puzzle, playout)
        if (goalFailure) {
          const failure = { fen: puzzle.fen, goal: puzzle.goal, run, reason: goalFailure }
          strongEngineFailures.push(failure)
          console.error(
            `ERROR: the user engine ${goalFailure} — puzzle ${puzzle.fen} ` +
              `(goal: ${puzzle.goal}, playout ${run + 1}/${config.playoutsPerPuzzle}). ` +
              `Its scores for this puzzle measure that failure, not the defender.`,
          )
        }
        const trimmed = trimPlayout(playout, puzzle.goal)
        playouts.push({
          endReason: trimmed.endReason,
          delayMoves: trimmed.delayMoves,
          trickiness: trimmed.trickiness,
          plies: trimmed.plies,
          // Every move the defender produced, not just the ones the trimming kept — these
          // measure what the opponent costs to run, which the trimming has no say in
          moveTimesMs: playout.defenderMoveTimesMs,
          tablebaseLookupsPerMove: playout.defenderTablebaseLookups,
        })
      } finally {
        Math.random = originalRandom
      }
    }
    return { puzzle, playouts }
  }

  return {
    puzzles,
    measurePuzzle,
    tablebase,
    verifyStrongEngine: () => assertStrongEngineLoadedSyzygy(strongEngine),
    strongEngineFailures: () => strongEngineFailures,
    shutDown: () => {
      defenderEngine.quit()
      strongEngine.quit()
    },
  }
}

export function resolveConfig(
  frontendRoot: string,
  overrides: Partial<PlayoutMeasurementConfig>,
): PlayoutMeasurementConfig {
  return {
    frontendRoot,
    binaryPath: overrides.binaryPath ?? DEFAULT_CONFIG.binaryPath,
    defenderThreads: overrides.defenderThreads ?? defaultWasmEngineThreads(),
    strongEngineThreads: overrides.strongEngineThreads ?? DEFAULT_STRONG_ENGINE_THREADS,
    puzzleCount: overrides.puzzleCount ?? DEFAULT_CONFIG.puzzleCount,
    playoutsPerPuzzle: overrides.playoutsPerPuzzle ?? DEFAULT_CONFIG.playoutsPerPuzzle,
    seed: overrides.seed ?? DEFAULT_CONFIG.seed,
    resample: overrides.resample ?? DEFAULT_CONFIG.resample,
    resumePreviousRun: overrides.resumePreviousRun ?? DEFAULT_CONFIG.resumePreviousRun,
    defenderKind: overrides.defenderKind ?? DEFAULT_CONFIG.defenderKind,
    minTablebaseRequestIntervalMs: overrides.minTablebaseRequestIntervalMs,
    puzzleSetFile: overrides.puzzleSetFile,
  }
}
