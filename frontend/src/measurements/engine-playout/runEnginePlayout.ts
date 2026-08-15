import path from 'node:path'
import { createSeededRandom, shuffled } from '@/measurements/shared/puzzleCatalog'
import {
  baselineFileFor,
  COMPARISON_DEFENDER,
  createPlayoutRunner,
  resolveConfig,
  PUZZLE_SET_FILE,
  type PlayoutMeasurementConfig,
} from './playoutHarness'
import { openRunStore, runDetailPath, runHeaderFor } from './playoutRunStore'
import { formatPuzzleLine, formatSummary, writeReport, type PuzzleMeasurement } from './report'
import { formatInFlightComparison, loadBaselinePuzzleScores } from './inFlightComparison'
import { TRICKINESS_THINKING_TIME_MS, USER_MOVE_THINKING_TIME_MS } from './strongEngine'

export type PlayoutMeasurementOptions = Partial<PlayoutMeasurementConfig> & {
  frontendRoot: string
}

// Keeps the processing order reproducible without tying it to the seed that drives puzzle
// sampling and the selector's move sampling — those must stay put when only the order moves
const PROCESSING_ORDER_SEED_OFFSET = 104_729

export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.round(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}min`
  if (minutes > 0) return `${minutes}min`
  return `${totalSeconds}s`
}

function formatClockTime(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export function formatEtaLine(done: number, total: number, elapsedMs: number, now: Date): string {
  const percent = Math.round((done / total) * 100)
  // Puzzles are processed in shuffled order precisely so this extrapolation holds: the mean
  // cost per puzzle stops drifting, so time elapsed tracks the fraction completed
  const remainingMs = (elapsedMs / done) * (total - done)
  if (remainingMs === 0) return `${percent}% done, finished at ${formatClockTime(now)}`
  const finishesAt = new Date(now.getTime() + remainingMs)
  return `${percent}% done, ETA: ${formatClockTime(finishesAt)} (${formatDuration(remainingMs)})`
}

export async function runEnginePlayout(options: PlayoutMeasurementOptions): Promise<void> {
  const config = resolveConfig(options.frontendRoot, options)
  const runner = createPlayoutRunner(config)

  // Puzzles cost very different amounts of time to play out — a held draw runs many times
  // longer than a quick mate — and a hand-built set (a divergence set, say) can easily be
  // ordered by exactly that. Shuffling the *processing* order makes the cost per puzzle
  // stationary, so a third of the puzzles really is about a third of the time and the ETA
  // holds. Each puzzle keeps its original index, which is both what seeds its playouts and
  // where its result is written, so the output files are byte-for-byte order-independent.
  const processingOrder = shuffled(
    runner.puzzles.map((puzzle, index) => ({ puzzle, index })),
    createSeededRandom(config.seed + PROCESSING_ORDER_SEED_OFFSET),
  )
  const measurementByIndex = Array.from<PuzzleMeasurement | undefined>({
    length: runner.puzzles.length,
  })

  const defenderDescription = {
    'move-selector': 'useMoveSelector',
    'engine-best-move': 'bare 800 ms multipv-1 search, no tablebase',
    offline: 'useMoveSelector with every tablebase request failing (offline)',
  }[config.defenderKind]
  console.log(
    `Playing out ${runner.puzzles.length} puzzles × ${config.playoutsPerPuzzle} ` +
      `(defender: ${defenderDescription}, WASM lite on ${config.defenderThreads} threads, ` +
      `user: native on ${config.strongEngineThreads} threads + Syzygy)`,
  )

  const baselineFile = baselineFileFor(config.defenderKind)
  const yamlPath = path.join(config.frontendRoot, baselineFile)

  // Opened before the first puzzle so a run that cannot be resumed says so immediately
  // rather than an hour in, and so every finished puzzle is on disk the moment it finishes
  const detailPath = runDetailPath(config.frontendRoot, baselineFile)
  const runStore = openRunStore(
    detailPath,
    runHeaderFor({
      defender: config.defenderKind,
      puzzleSet: config.puzzleSetFile ?? PUZZLE_SET_FILE,
      seed: config.seed,
      playoutsPerPuzzle: config.playoutsPerPuzzle,
      puzzles: runner.puzzles,
    }),
    config.resumePreviousRun,
  )
  const resumed = new Map(
    runStore.completed.map((measurement) => [measurement.puzzle.fen, measurement] as const),
  )
  for (const measurement of runStore.completed) {
    const index = runner.puzzles.findIndex((puzzle) => puzzle.fen === measurement.puzzle.fen)
    if (index !== -1) measurementByIndex[index] = measurement
  }
  const playoutsAlreadyMeasured = (fen: string) => resumed.get(fen)?.playouts.length ?? 0
  // A puzzle is left to do if it has fewer playouts than asked for — which covers both an
  // interrupted run (none) and a run continued with a higher --playouts (some), where only
  // the missing playouts are measured and appended to the ones already on disk
  const remaining = processingOrder.filter(
    ({ puzzle }) => playoutsAlreadyMeasured(puzzle.fen) < config.playoutsPerPuzzle,
  )
  // Always the shipping selector's baseline, whatever this run's defender is. When they are
  // the same file, reading it here — before the run writes over it at the end — compares
  // against the previous move-selector run.
  const comparisonBaselineFile = baselineFileFor(COMPARISON_DEFENDER)
  const comparisonBaselinePath = path.join(config.frontendRoot, comparisonBaselineFile)
  const baselineScores = loadBaselinePuzzleScores(comparisonBaselinePath)

  const startedAt = Date.now()
  // Seeded with the resumed puzzles so the in-flight comparison covers the whole run, not
  // just the part measured since the interruption
  const done: PuzzleMeasurement[] = runStore.completed.filter(
    (measurement) => measurement.playouts.length >= config.playoutsPerPuzzle,
  )
  try {
    await runner.verifyStrongEngine()
    if (runStore.completed.length > 0) {
      console.log(
        `Continuing ${detailPath}: ${done.length} of ${runner.puzzles.length} puzzles already ` +
          `have all ${config.playoutsPerPuzzle} playouts, ` +
          `${runStore.completed.length - done.length} are topped up to that`,
      )
    }
    if (!baselineScores) {
      console.log(
        `No baseline at ${comparisonBaselinePath} yet — running without an in-flight comparison`,
      )
    } else {
      console.log(`In-flight comparison against ${comparisonBaselineFile} (move-selector)`)
    }
    console.log('')
    for (const [position, { puzzle, index }] of remaining.entries()) {
      const earlier = resumed.get(puzzle.fen)
      const measured = await runner.measurePuzzle(puzzle, index, earlier?.playouts.length)
      // Written before anything else can fail, so an interrupted run never loses a playout
      // it has already paid for. Only what was measured now goes in — the earlier playouts
      // are already a row of their own.
      runStore.append(measured)
      const measurement = earlier
        ? { puzzle: earlier.puzzle, playouts: [...earlier.playouts, ...measured.playouts] }
        : measured
      measurementByIndex[index] = measurement
      done.push(measurement)
      const block = [
        `[${done.length}/${processingOrder.length}] ${formatPuzzleLine(measurement)}`,
        ...(baselineScores
          ? [
              formatInFlightComparison(done, baselineScores, {
                baselineName: comparisonBaselineFile,
              }),
            ]
          : []),
        // Extrapolated from this session's own work only: the resumed puzzles were measured
        // in some earlier session whose pace says nothing about this one
        formatEtaLine(position + 1, remaining.length, Date.now() - startedAt, new Date()),
      ]
      console.log(`${block.join('\n')}\n`)
    }
  } finally {
    runner.shutDown()
  }

  // Back into the puzzle set's own order, so the written files don't depend on how the run
  // happened to be scheduled
  const measurements = measurementByIndex.filter(
    (measurement): measurement is PuzzleMeasurement => measurement !== undefined,
  )

  writeReport(yamlPath, measurements, {
    defender: config.defenderKind,
    temperature: 'minimum',
    puzzleSet: config.puzzleSetFile ?? PUZZLE_SET_FILE,
    seed: config.seed,
    playoutsPerPuzzle: config.playoutsPerPuzzle,
    defenderThreads: config.defenderThreads,
    strongEngineThreads: config.strongEngineThreads,
    userMoveThinkingTimeMs: USER_MOVE_THINKING_TIME_MS,
    trickinessThinkingTimeMs: TRICKINESS_THINKING_TIME_MS,
  })

  // Repeated at the end because a single line an hour ago scrolls away, and a run with
  // these in it is not a valid baseline — the affected puzzles scored the user engine's
  // failure rather than the defender's resistance
  const goalFailures = runner.strongEngineFailures()
  if (goalFailures.length > 0) {
    console.error(
      `\nERROR: the user engine failed to reach the puzzle goal in ${goalFailures.length} ` +
        `playout(s). This should never happen — treat this baseline as suspect:`,
    )
    for (const failure of goalFailures) {
      console.error(`  ${failure.fen} (goal: ${failure.goal}) — ${failure.reason}`)
    }
  }

  console.log(`\n${formatSummary(measurements)}`)
  console.log(`\nBaseline written to ${yamlPath}\nPer-ply detail written to ${detailPath}`)
  console.log(`Tablebase requests: ${runner.tablebase.networkRequestCount()}`)
}
