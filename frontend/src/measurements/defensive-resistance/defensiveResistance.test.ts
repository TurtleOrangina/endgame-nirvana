// @vitest-environment node
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vite-plus/test'
import {
  createMeasurementRunner,
  DEFAULT_CONFIG,
  defensivePerfection,
  formatPuzzleReport,
  formatSummary,
  fractionsLost,
  writeReport,
  type PuzzleMeasurement,
} from './measurementHarness'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// Explicitly `isFinite` rather than `||`, so an intentional 0 (e.g. running the fixed
// queen-vs-rook puzzle alone) isn't mistaken for "unset"
function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return process.env[name] !== undefined && Number.isFinite(parsed) ? parsed : fallback
}

const config = {
  frontendRoot,
  binaryPath: process.env.RESISTANCE_STOCKFISH ?? DEFAULT_CONFIG.binaryPath,
  engineThreads: Number(process.env.RESISTANCE_THREADS) || undefined,
  puzzlesPerGroup: numberFromEnv('RESISTANCE_PUZZLES_PER_GROUP', DEFAULT_CONFIG.puzzlesPerGroup),
  playoutsPerPuzzle: numberFromEnv('RESISTANCE_PLAYOUTS', DEFAULT_CONFIG.playoutsPerPuzzle),
  seed: numberFromEnv('RESISTANCE_SEED', DEFAULT_CONFIG.seed),
  minTablebaseRequestIntervalMs: Number(process.env.RESISTANCE_REQUEST_INTERVAL_MS) || undefined,
}

// One puzzle takes minutes: a playout is dozens of engine searches plus (on a cold cache)
// dozens of rate-limited Lichess lookups. Hours in total, so `vp test` must not pick this
// up by accident — it only runs when explicitly asked for, and only if the native engine
// the measurement drives is actually present.
const isEnabled = process.env.RUN_RESISTANCE_MEASUREMENT === '1' && existsSync(config.binaryPath)

describe.runIf(isEnabled)('engine defensive resistance', () => {
  const runner = createMeasurementRunner(config)
  const measurements: PuzzleMeasurement[] = []

  afterAll(() => {
    runner.shutDown()
    if (measurements.length === 0) return
    const { jsonPath, textPath } = writeReport(measurements, config, runner.tablebase)
    // `vp test` intercepts console output by default, so the files are the real deliverable
    console.log(formatSummary(measurements, runner.tablebase))
    console.log(`\nReport written to ${textPath}\nPer-move detail written to ${jsonPath}`)
  })

  test.each(runner.puzzles.map((puzzle) => [`${puzzle.group} — ${puzzle.fen}`, puzzle] as const))(
    '%s',
    async (_label, puzzle) => {
      const measurement = await runner.measurePuzzle(puzzle)
      measurements.push(measurement)
      console.log(formatPuzzleReport(measurement))

      // The measurement itself has no pass/fail threshold — the numbers are the output.
      // These only assert the playouts are usable as evidence: an unfinished game or an
      // impossible fraction means the harness is broken, not that the engine defends badly.
      for (const playout of measurement.playouts) {
        expect(playout.outcome).toBe('checkmate')
        expect(playout.defensiveMoves.length).toBeGreaterThan(0)
        expect(defensivePerfection(playout)).toBeGreaterThan(0)
        expect(defensivePerfection(playout)).toBeLessThanOrEqual(1)
      }
      for (const fraction of fractionsLost([measurement])) {
        expect(fraction).toBeGreaterThanOrEqual(0)
        expect(fraction).toBeLessThanOrEqual(1)
      }
    },
    numberFromEnv('RESISTANCE_PUZZLE_TIMEOUT_MS', 60 * 60 * 1000),
  )
})
