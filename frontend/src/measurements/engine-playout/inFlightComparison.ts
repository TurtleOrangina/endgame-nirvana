import { existsSync, readFileSync } from 'node:fs'
import { parseMappingList } from './yaml'
import { averageMoveTimeMs, scorePuzzle, type PuzzleMeasurement } from './report'

/**
 * The running comparison against a committed baseline, so a run that is going the wrong way
 * can be abandoned in its first ten minutes instead of its last.
 *
 * Every difference is *paired*: it compares the puzzles measured so far against the same
 * puzzles in the baseline, never against the baseline's overall mean. Between-position
 * variance dwarfs the effect being measured here (see this measurement's CLAUDE.md), so an
 * unpaired running mean would mostly report which positions happen to have come up yet —
 * and with the processing order shuffled, that is a different subset every run.
 */
export interface BaselinePuzzleScore {
  delayMoves: number
  trickiness: number
  // Absent from baselines written before this was recorded per puzzle
  avgMoveTimeMs: number | null
}

export function loadBaselinePuzzleScores(
  yamlPath: string,
): Map<string, BaselinePuzzleScore> | null {
  if (!existsSync(yamlPath)) return null
  const rows = parseMappingList(readFileSync(yamlPath, 'utf8'), 'puzzles')
  const scores = new Map<string, BaselinePuzzleScore>()
  for (const row of rows) {
    const { fen, delayMoves, trickiness, avgMoveTimeMs } = row
    if (typeof fen !== 'string' || typeof delayMoves !== 'number' || typeof trickiness !== 'number')
      continue
    scores.set(fen, {
      delayMoves,
      trickiness,
      avgMoveTimeMs: typeof avgMoveTimeMs === 'number' ? avgMoveTimeMs : null,
    })
  }
  return scores.size === 0 ? null : scores
}

interface PairedPuzzle {
  goal: string
  delayMoves: number
  trickiness: number
  avgMoveTimeMs: number
  baseline: BaselinePuzzleScore
}

function pair(
  measurements: PuzzleMeasurement[],
  baseline: Map<string, BaselinePuzzleScore>,
): PairedPuzzle[] {
  return measurements.flatMap((measurement) => {
    const baselineScore = baseline.get(measurement.puzzle.fen)
    if (!baselineScore) return []
    const score = scorePuzzle(measurement)
    return [
      {
        goal: measurement.puzzle.goal,
        delayMoves: score.delayMoves,
        trickiness: score.trickiness,
        avgMoveTimeMs: averageMoveTimeMs(measurement),
        baseline: baselineScore,
      },
    ]
  })
}

interface PairedDifference {
  mean: number
  // Standard error of the paired differences, computed exactly as
  // scripts/compare-playout-baselines.mjs does, so "significant" means the same thing here
  // as the `*` that script prints
  sem: number
  count: number
}

function pairedDifference(
  rows: PairedPuzzle[],
  current: (row: PairedPuzzle) => number,
  previous: (row: PairedPuzzle) => number | null,
): PairedDifference | null {
  const differences = rows.flatMap((row) => {
    const before = previous(row)
    return before === null ? [] : [current(row) - before]
  })
  if (differences.length === 0) return null
  const average = differences.reduce((sum, value) => sum + value, 0) / differences.length
  const variance =
    differences.reduce((sum, value) => sum + (value - average) ** 2, 0) / differences.length
  return { mean: average, sem: Math.sqrt(variance / differences.length), count: differences.length }
}

/**
 * The measurement's own threshold for a real change: more than two standard errors from
 * zero. A single pair is never significant however far apart the two numbers are — its
 * spread is zero by construction, which would otherwise make the very first puzzle of a run
 * light up.
 */
function isSignificant(difference: PairedDifference): boolean {
  return difference.count >= 2 && Math.abs(difference.mean) > 2 * difference.sem
}

const ANSI = { green: '\u001B[32m', red: '\u001B[31m', gray: '\u001B[90m', reset: '\u001B[39m' }

// Colour is for a human watching a run, so it is dropped when stdout is not a terminal
// (piped to a file, read by CI) and when NO_COLOR asks for none
export function supportsColor(): boolean {
  return process.env.NO_COLOR === undefined && process.stdout.isTTY === true
}

function signed(
  difference: PairedDifference | null,
  digits: number,
  options: { unit?: string; higherIsBetter: boolean; color: boolean },
): string {
  if (difference === null) return 'n/a'
  const text = `${difference.mean < 0 ? '-' : '+'}${Math.abs(difference.mean).toFixed(digits)}${options.unit ?? ''}`
  if (!options.color) return text
  if (!isSignificant(difference)) return `${ANSI.gray}${text}${ANSI.reset}`
  const isImprovement = difference.mean > 0 === options.higherIsBetter
  return `${isImprovement ? ANSI.green : ANSI.red}${text}${ANSI.reset}`
}

export function formatInFlightComparison(
  measurements: PuzzleMeasurement[],
  baseline: Map<string, BaselinePuzzleScore>,
  options: { color?: boolean; baselineName?: string } = {},
): string {
  const color = options.color ?? supportsColor()
  const rows = pair(measurements, baseline)
  const forGoal = (goal: string): PairedPuzzle[] => rows.filter((row) => row.goal === goal)
  // More resistance and more traps are the point of the defender, so up is better
  const delay = (goal: string): string =>
    signed(
      pairedDifference(
        forGoal(goal),
        (row) => row.delayMoves,
        (row) => row.baseline.delayMoves,
      ),
      1,
      { higherIsBetter: true, color },
    )
  const trickiness = (goal: string): string =>
    signed(
      pairedDifference(
        forGoal(goal),
        (row) => row.trickiness,
        (row) => row.baseline.trickiness,
      ),
      2,
      { higherIsBetter: true, color },
    )
  // A defender that got slower costs the user waiting time, so here up is worse
  const thinkingTime = signed(
    pairedDifference(
      rows,
      (row) => row.avgMoveTimeMs,
      (row) => row.baseline.avgMoveTimeMs,
    ),
    0,
    { unit: 'ms', higherIsBetter: false, color },
  )
  // No delay on draws: holding a draw for longer is not a better defense, only a trickier
  // one is, so it is neither reported nor compared (see report.ts's summarizeGroup)
  return (
    `In flight comparison vs ${options.baselineName ?? 'baseline'}: ` +
    `delay(wins): ${delay('win')}, trickiness(wins): ${trickiness('win')}, ` +
    `trickiness(draws): ${trickiness('draw')}, thinking_time: ${thinkingTime}`
  )
}
