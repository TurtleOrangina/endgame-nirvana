// @vitest-environment node
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, test } from 'vite-plus/test'
import { MAX_TRICKINESS } from '@/utils/maintainFraction'
import {
  baselineFileFor,
  createPlayoutRunner,
  detailFileFor,
  PUZZLE_SET_FILE,
  resolveConfig,
} from './playoutHarness'
import { formatPuzzleLine, formatSummary, writeReport, type PuzzleMeasurement } from './report'
import { TRICKINESS_THINKING_TIME_MS, USER_MOVE_THINKING_TIME_MS } from './strongEngine'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// Explicitly `isFinite` rather than `||`, so an intentional 0 isn't mistaken for "unset"
function numberFromEnv(name: string, fallback: number | undefined): number | undefined {
  const parsed = Number(process.env[name])
  return process.env[name] !== undefined && Number.isFinite(parsed) ? parsed : fallback
}

const config = resolveConfig(frontendRoot, {
  binaryPath: process.env.PLAYOUT_STOCKFISH,
  defenderThreads: numberFromEnv('PLAYOUT_THREADS', undefined),
  strongEngineThreads: numberFromEnv('PLAYOUT_STRONG_THREADS', undefined),
  puzzleCount: numberFromEnv('PLAYOUT_PUZZLES', undefined),
  playoutsPerPuzzle: numberFromEnv('PLAYOUT_PLAYOUTS', undefined),
  seed: numberFromEnv('PLAYOUT_SEED', undefined),
  minTablebaseRequestIntervalMs: numberFromEnv('PLAYOUT_REQUEST_INTERVAL_MS', undefined),
})

// A full run is hours of engine time, so `vp test` must not pick this up by accident — it
// only runs when explicitly asked for, and only if the native engine standing in for the
// user is actually present.
const isEnabled = process.env.RUN_PLAYOUT_MEASUREMENT === '1' && existsSync(config.binaryPath)

describe.runIf(isEnabled)('engine playout', () => {
  const runner = createPlayoutRunner(config)
  const measurements: PuzzleMeasurement[] = []

  afterAll(() => {
    runner.shutDown()
    if (measurements.length === 0) return
    writeReport(
      {
        yamlPath: path.join(frontendRoot, baselineFileFor(config.defenderKind)),
        detailPath: path.join(frontendRoot, detailFileFor(config.defenderKind)),
      },
      measurements,
      {
        defender: config.defenderKind,
        temperature: config.defenderKind === 'with-variance' ? 'app' : 'minimum',
        puzzleSet: config.puzzleSetFile ?? PUZZLE_SET_FILE,
        seed: config.seed,
        playoutsPerPuzzle: config.playoutsPerPuzzle,
        defenderThreads: config.defenderThreads,
        strongEngineThreads: config.strongEngineThreads,
        userMoveThinkingTimeMs: USER_MOVE_THINKING_TIME_MS,
        trickinessThinkingTimeMs: TRICKINESS_THINKING_TIME_MS,
      },
    )
    // `vp test` intercepts console output by default, so the files are the real deliverable
    console.log(formatSummary(measurements))
  })

  test.each(
    runner.puzzles.map(
      (puzzle, index) =>
        [`${puzzle.goal} ${puzzle.men}men — ${puzzle.fen}`, puzzle, index] as const,
    ),
  )(
    '%s',
    async (_label, puzzle, index) => {
      const measurement = await runner.measurePuzzle(puzzle, index)
      measurements.push(measurement)
      console.log(formatPuzzleLine(measurement))

      // The measurement has no pass/fail threshold — the numbers are the output. These
      // only assert the playouts are usable as evidence: a playout that never resolved or
      // an out-of-range trickiness means the harness is broken, not that the engine
      // defends badly.
      for (const playout of measurement.playouts) {
        expect(playout.endReason).not.toBe('ply-limit-reached')
        expect(playout.delayMoves).toBeGreaterThan(0)
        expect(playout.trickiness).toBeGreaterThanOrEqual(0)
        expect(playout.trickiness).toBeLessThanOrEqual(MAX_TRICKINESS)
      }
    },
    numberFromEnv('PLAYOUT_PUZZLE_TIMEOUT_MS', 60 * 60 * 1000),
  )
})
