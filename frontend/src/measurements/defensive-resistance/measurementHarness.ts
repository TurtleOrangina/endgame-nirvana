import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { createNativeStockfishEngine, NATIVE_STOCKFISH_PATH } from './nativeStockfishEngine'
import { playOutPuzzle, type PlayoutResult } from './playout'
import { createSeededRandom, selectPuzzles, type SelectedPuzzle } from './puzzleSelection'
import { createTablebaseClient, type TablebaseClient } from './tablebaseClient'
import { formatPercent, summarize } from './statistics'

// Everything the CLI script (scripts/measure-defensive-resistance.mjs) and the Vitest
// suite (defensiveResistance.test.ts) have in common: the wiring, one puzzle's worth of
// playouts, and the reporting. The two entry points differ only in how they iterate the
// puzzles — the script in a plain loop, Vitest one test case per puzzle.

export interface MeasurementConfig {
  frontendRoot: string
  binaryPath: string
  engineThreads?: number
  puzzlesPerGroup: number
  // The defender samples its move randomly, so a single playout of one puzzle says very
  // little. Each puzzle is replayed this many times with different seeds.
  playoutsPerPuzzle: number
  seed: number
  minTablebaseRequestIntervalMs?: number
}

export interface PuzzleMeasurement {
  puzzle: SelectedPuzzle
  playouts: PlayoutResult[]
}

export const PUZZLE_GROUPS = ['Queen vs Rook', 'Pawn Endgames', 'Rook Endgames', 'Other'] as const

export const DEFAULT_CONFIG = {
  binaryPath: NATIVE_STOCKFISH_PATH,
  puzzlesPerGroup: 5,
  playoutsPerPuzzle: 3,
  seed: 20_260_802,
} as const

function meanOf(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

// How long the defense actually held out, as a share of the ply count a perfect defense
// would have forced. 100% means the defender was flawless.
export function defensivePerfection(playout: PlayoutResult): number {
  return playout.optimalPlyCount > 0 ? playout.actualPlyCount / playout.optimalPlyCount : 0
}

export function fractionsLost(measurements: PuzzleMeasurement[]): number[] {
  return measurements.flatMap((measurement) =>
    measurement.playouts.flatMap((playout) =>
      playout.defensiveMoves.map((move) => move.fractionLost),
    ),
  )
}

export interface MeasurementRunner {
  puzzles: SelectedPuzzle[]
  measurePuzzle(puzzle: SelectedPuzzle): Promise<PuzzleMeasurement>
  tablebase: TablebaseClient
  shutDown(): void
}

export function createMeasurementRunner(config: MeasurementConfig): MeasurementRunner {
  const tablebase = createTablebaseClient(
    path.join(config.frontendRoot, '.tablebase-cache'),
    config.minTablebaseRequestIntervalMs,
  )
  tablebase.installFetchInterception()
  const engine = createNativeStockfishEngine(config.binaryPath, config.engineThreads)
  const puzzles = selectPuzzles(
    path.join(config.frontendRoot, 'public', 'exercises.json'),
    config.seed,
    config.puzzlesPerGroup,
  )

  async function measurePuzzle(puzzle: SelectedPuzzle): Promise<PuzzleMeasurement> {
    const playouts: PlayoutResult[] = []
    for (let index = 0; index < config.playoutsPerPuzzle; index++) {
      // The selector samples through Math.random; seeding it per playout keeps the whole
      // measurement reproducible while still varying the defense between repetitions.
      const originalRandom = Math.random
      Math.random = createSeededRandom(config.seed + index * 7919)
      try {
        playouts.push(await playOutPuzzle({ fen: puzzle.fen, tablebase, engine }))
      } finally {
        Math.random = originalRandom
      }
    }
    return { puzzle, playouts }
  }

  return { puzzles, measurePuzzle, tablebase, shutDown: () => engine.quit() }
}

export function formatPuzzleReport({ puzzle, playouts }: PuzzleMeasurement): string {
  const lost = summarize(fractionsLost([{ puzzle, playouts }]))
  return (
    `\n[${puzzle.group}] ${puzzle.categoryPath}\n` +
    `  fen              ${puzzle.fen}  (elo ${puzzle.difficulty}, ${puzzle.pieceCount} men)\n` +
    `  optimal plies    ${playouts[0]?.optimalPlyCount ?? 0} (DTM at start)\n` +
    `  actual plies     ${playouts.map((playout) => playout.actualPlyCount).join(' / ')}\n` +
    `  perfection       ${formatPercent(meanOf(playouts.map(defensivePerfection)))}` +
    '  (actual / optimal, mean over playouts)\n' +
    `  fraction lost    mean ${formatPercent(lost.mean, 2)}  ` +
    `max ${formatPercent(lost.max, 2)}  sd ${formatPercent(lost.stdDev, 2)}  ` +
    `(over ${lost.count} defensive moves)\n` +
    `  outcomes         ${playouts.map((playout) => playout.outcome).join(', ')}` +
    (playouts.some((playout) => playout.exceededFiftyMoveRule)
      ? '\n  note             shortest-mate play ran past the 50-move rule'
      : '')
  )
}

function formatGroupLine(label: string, measurements: PuzzleMeasurement[]): string {
  const lost = summarize(fractionsLost(measurements))
  const perfection = meanOf(
    measurements.flatMap((measurement) => measurement.playouts.map(defensivePerfection)),
  )
  return (
    `  ${label.padEnd(16)} perfection ${formatPercent(perfection).padStart(6)}   ` +
    `lost/move: mean ${formatPercent(lost.mean, 2).padStart(6)}  ` +
    `max ${formatPercent(lost.max, 2).padStart(6)}  ` +
    `sd ${formatPercent(lost.stdDev, 2).padStart(6)}  ` +
    `(${lost.count} moves)`
  )
}

export function formatSummary(
  measurements: PuzzleMeasurement[],
  tablebase: TablebaseClient,
): string {
  const byGroup = PUZZLE_GROUPS.map((group) => ({
    group,
    measurements: measurements.filter((measurement) => measurement.puzzle.group === group),
  })).filter(({ measurements: inGroup }) => inGroup.length > 0)

  const incomplete = measurements.flatMap((measurement) =>
    measurement.playouts.filter((playout) => playout.outcome !== 'checkmate'),
  )

  return (
    '\n=== Summary ===\n' +
    byGroup.map(({ group, measurements: inGroup }) => formatGroupLine(group, inGroup)).join('\n') +
    (byGroup.length > 1 ? `\n${formatGroupLine('ALL', measurements)}` : '') +
    (incomplete.length > 0
      ? `\n\n${incomplete.length} playout(s) did not end in checkmate and are included ` +
        `above: ${[...new Set(incomplete.map((playout) => playout.outcome))].join(', ')}`
      : '') +
    `\n\nPooled over ${summarize(fractionsLost(measurements)).count} defensive moves. ` +
    `${tablebase.networkRequestCount()} tablebase requests hit the network.`
  )
}

/**
 * Writes the run's per-move detail (`.json`) and its human-readable report (`.txt`).
 *
 * Both are named after the configuration that produced them, so a quick smoke run can
 * never clobber a long one — regenerating that costs hours of engine time. The text
 * report is written rather than only logged because `vp test` intercepts console output
 * by default, which would otherwise throw away the entire result of a Vitest run.
 */
export function writeReport(
  measurements: PuzzleMeasurement[],
  config: MeasurementConfig,
  tablebase: TablebaseClient,
): { jsonPath: string; textPath: string } {
  const basePath = path.join(
    config.frontendRoot,
    `defensive-resistance-${measurements.length}puzzles-` +
      `${config.playoutsPerPuzzle}playouts-seed${config.seed}`,
  )
  const jsonPath = `${basePath}.json`
  const textPath = `${basePath}.txt`
  writeFileSync(jsonPath, JSON.stringify(measurements, null, 2))
  writeFileSync(
    textPath,
    measurements.map(formatPuzzleReport).join('\n') + formatSummary(measurements, tablebase) + '\n',
  )
  return { jsonPath, textPath }
}
