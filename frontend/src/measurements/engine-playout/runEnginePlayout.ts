import path from 'node:path'
import { createSeededRandom, shuffled } from '@/measurements/shared/puzzleCatalog'
import {
  baselineFileFor,
  COMPARISON_DEFENDER,
  createPlayoutRunner,
  resolveConfig,
  detailFileFor,
  PUZZLE_SET_FILE,
  type PlayoutMeasurementConfig,
} from './playoutHarness'
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

  // The puzzle set is grouped by stratum — every win goal before every draw goal, and few-men
  // before many-men within each — and those groups cost very different amounts of time to
  // play out. Walking it in file order would make the run's pace lurch at each group
  // boundary and any ETA useless. Shuffling the *processing* order makes the cost per puzzle
  // stationary, so a third of the puzzles really is about a third of the time. Each puzzle
  // keeps its original index, which is both what seeds its playouts and where its result is
  // written, so the output files are byte-for-byte order-independent.
  const processingOrder = shuffled(
    runner.puzzles.map((puzzle, index) => ({ puzzle, index })),
    createSeededRandom(config.seed + PROCESSING_ORDER_SEED_OFFSET),
  )
  const measurementByIndex = Array.from<PuzzleMeasurement | undefined>({
    length: runner.puzzles.length,
  })

  const defenderDescription = {
    'move-selector': 'useMoveSelector',
    multipv1: 'plain multipv-1 engine, no tablebase',
    'multipv1-tablebase': 'plain multipv-1 engine, tablebase for won ≤7-men positions',
    'no-trickster': 'useMoveSelector with the Trickster switched off',
    'multipv-rank-delayer': 'useMoveSelector, delayer falling back to the multipv ordering',
    'with-variance': "useMoveSelector at the app's own temperature, its sampling included",
    'trickster-led': 'useMoveSelector with the delayer no longer squared over the Trickster',
    'trickster-geomean': 'useMoveSelector with the Trickster combining probes by geometric mean',
    'trickster-focused':
      'useMoveSelector probing fewer candidates, each for longer (now production)',
    'trickster-unfocused': 'useMoveSelector probing every candidate, as it did before',
    'zeroing-distance': 'useMoveSelector seeding dtd by min(dtm, dtz) where zeroing decides',
    'dtm-only-distance': 'useMoveSelector seeding dtd by dtm alone',
  }[config.defenderKind]
  console.log(
    `Playing out ${runner.puzzles.length} puzzles × ${config.playoutsPerPuzzle} ` +
      `(defender: ${defenderDescription}, WASM lite on ${config.defenderThreads} threads, ` +
      `user: native on ${config.strongEngineThreads} threads + Syzygy)`,
  )

  const paths = {
    yamlPath: path.join(config.frontendRoot, baselineFileFor(config.defenderKind)),
    detailPath: path.join(config.frontendRoot, detailFileFor(config.defenderKind)),
  }
  // Always the shipping selector's baseline, whatever this run's defender is. When they are
  // the same file, reading it here — before the run writes over it at the end — compares
  // against the previous move-selector run.
  const comparisonBaselineFile = baselineFileFor(COMPARISON_DEFENDER)
  const comparisonBaselinePath = path.join(config.frontendRoot, comparisonBaselineFile)
  const baselineScores = loadBaselinePuzzleScores(comparisonBaselinePath)

  const startedAt = Date.now()
  const done: PuzzleMeasurement[] = []
  try {
    await runner.verifyStrongEngine()
    if (!baselineScores) {
      console.log(
        `No baseline at ${comparisonBaselinePath} yet — running without an in-flight comparison`,
      )
    } else {
      console.log(`In-flight comparison against ${comparisonBaselineFile} (move-selector)`)
    }
    console.log('')
    for (const [position, { puzzle, index }] of processingOrder.entries()) {
      const measurement = await runner.measurePuzzle(puzzle, index)
      measurementByIndex[index] = measurement
      done.push(measurement)
      const block = [
        `[${position + 1}/${processingOrder.length}] ${formatPuzzleLine(measurement)}`,
        ...(baselineScores
          ? [
              formatInFlightComparison(done, baselineScores, {
                baselineName: comparisonBaselineFile,
              }),
            ]
          : []),
        formatEtaLine(position + 1, processingOrder.length, Date.now() - startedAt, new Date()),
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

  writeReport(paths, measurements, {
    defender: config.defenderKind,
    temperature: config.defenderKind === 'with-variance' ? 'app' : 'minimum',
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
  console.log(
    `\nBaseline written to ${paths.yamlPath}\nPer-ply detail written to ${paths.detailPath}`,
  )
  console.log(`Tablebase requests: ${runner.tablebase.networkRequestCount()}`)
}
