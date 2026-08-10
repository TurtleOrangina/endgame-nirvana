import { writeFileSync } from 'node:fs'
import { summarize } from '@/measurements/shared/statistics'
import { formatYaml, type YamlValue } from './yaml'
import { MAX_TABLEBASE_MEN, type PlayoutPuzzle } from './playoutPuzzleSelection'
import { combinedScore } from './playoutTrimming'
import type { DefenderKind, PlayoutEndReason, PlayoutPly } from './enginePlayout'

export interface PuzzleMeasurement {
  puzzle: PlayoutPuzzle
  playouts: {
    endReason: PlayoutEndReason
    delayMoves: number
    trickiness: number
    plies: PlayoutPly[]
    moveTimesMs: number[]
  }[]
}

function moveTimesOf(measurements: PuzzleMeasurement[]): number[] {
  return measurements.flatMap((measurement) =>
    measurement.playouts.flatMap((playout) => playout.moveTimesMs),
  )
}

// Kept as a scalar on the puzzle itself, not only inside its playouts: the paired
// comparisons read a puzzle's own row (see yaml.ts's parseMappingList), so a number that
// lives only in the nested block cannot be compared across runs
export function averageMoveTimeMs(measurement: PuzzleMeasurement): number {
  return mean(moveTimesOf([measurement]))
}

// What the opponent costs to run, over every move it produced. Reported per run rather
// than per puzzle: it says whether a defender that scores better also got slower, which a
// user waiting for a reply feels directly.
function moveTimeSummary(moveTimesMs: number[]): YamlValue {
  const { count, min, mean, max, stdDev } = summarize(moveTimesMs)
  return {
    moves: count,
    min: round(min, 0),
    mean: round(mean, 0),
    max: round(max, 0),
    sd: round(stdDev, 0),
  }
}

function formatMoveTimeLine(moveTimesMs: number[]): string {
  const { count, min, mean, max, stdDev } = summarize(moveTimesMs)
  const parts = [min, mean, max, stdDev].map((value) => value.toFixed(0))
  return `  move_time min/avg/max/stddev: ${parts.join('/')} ms  (n=${count})`
}

export interface PlayoutReportConfig {
  defender: DefenderKind
  // Whether the selector sampled its moves ("app") or always took its highest-weighted
  // candidate ("minimum"). Recorded because it changes what a run measures, not just how
  // noisy it is.
  temperature: 'minimum' | 'app'
  // Which puzzle set the run played. Recorded because scores are only ever comparable to
  // runs on the *same* set, and a baseline built from a targeted set (a divergence set, say)
  // is otherwise indistinguishable from one built from the committed catalog.
  puzzleSet: string
  seed: number
  playoutsPerPuzzle: number
  defenderThreads: number
  strongEngineThreads: number
  userMoveThinkingTimeMs: number
  trickinessThinkingTimeMs: number
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function round(value: number, digits = 3): number {
  return Number(value.toFixed(digits))
}

/**
 * The scored line in algebraic notation, ready to be replayed on a board from the puzzle's
 * starting position. It is always a legal continuation of that position — both cuts keep a
 * prefix, and a spliced repetition loop starts and ends in the same position — so the moves
 * are numbered from 1 rather than carrying the FENs' own (now jumping) move numbers.
 */
export function formatMoveLine(plies: PlayoutPly[]): string {
  let moveNumber = 1
  const parts: string[] = []
  for (const [index, ply] of plies.entries()) {
    const isWhiteToMove = ply.fenBefore.split(' ')[1] === 'w'
    if (isWhiteToMove) parts.push(`${moveNumber}.`)
    else if (index === 0) parts.push(`${moveNumber}...`)
    parts.push(ply.san)
    if (!isWhiteToMove) moveNumber++
  }
  return parts.join(' ')
}

// How many of the user's positions the length-controlled trickiness averages over. Raw
// trickiness is a mean over *every* position the user faced, so a defender that lasts longer
// is scored over more easy ones and reads as less tricky — within a single baseline the two
// correlate at -0.59 on wins and -0.40 on draws. Averaging a fixed prefix instead keeps two
// defenders' trickiness comparable when their delay is not, so a "trickiness gain" that is
// really just a shorter defense stops looking like one.
const EARLY_TRICKINESS_POSITIONS = 4

function earlyTrickiness(plies: PlayoutPly[]): number {
  const values = plies
    .flatMap((ply) => (ply.trickiness === null ? [] : [ply.trickiness]))
    .slice(0, EARLY_TRICKINESS_POSITIONS)
  return mean(values)
}

export interface PuzzleScore {
  delayMoves: number
  trickiness: number
  // Trickiness over the first EARLY_TRICKINESS_POSITIONS user positions only
  earlyTrickiness: number
  combined: number
}

// A puzzle's score is the mean over its playouts — the selector samples its moves, so a
// single playout is one draw from a distribution, not the puzzle's value
export function scorePuzzle(measurement: PuzzleMeasurement): PuzzleScore {
  const delayMoves = mean(measurement.playouts.map((playout) => playout.delayMoves))
  const trickiness = mean(measurement.playouts.map((playout) => playout.trickiness))
  return {
    delayMoves,
    trickiness,
    earlyTrickiness: mean(measurement.playouts.map((playout) => earlyTrickiness(playout.plies))),
    combined: combinedScore(delayMoves, trickiness),
  }
}

// sd is spread across puzzles (mostly real differences between positions); sem is how
// precisely this run pinned the mean down, and so the scale on which two runs' means can
// be compared at all. Both engines search by time, which makes a single playout
// irreproducible — only the averages are stable.
function distribution(values: number[]): YamlValue {
  const { mean: average, stdDev } = summarize(values)
  return {
    mean: round(average),
    sd: round(stdDev),
    sem: values.length === 0 ? 0 : round(stdDev / Math.sqrt(values.length)),
  }
}

function summarizeGroup(measurements: PuzzleMeasurement[]): YamlValue {
  const scores = measurements.map(scorePuzzle)
  return {
    puzzles: measurements.length,
    delayMoves: distribution(scores.map((score) => score.delayMoves)),
    trickiness: distribution(scores.map((score) => score.trickiness)),
    earlyTrickiness: distribution(scores.map((score) => score.earlyTrickiness)),
    combined: distribution(scores.map((score) => score.combined)),
  }
}

export const REPORT_GROUPS: {
  key: string
  label: string
  includes: (p: PlayoutPuzzle) => boolean
}[] = [
  { key: 'all', label: 'all puzzles', includes: () => true },
  {
    key: 'manyMen',
    label: `>${MAX_TABLEBASE_MEN} men (no tablebase)`,
    includes: (puzzle) => puzzle.men > MAX_TABLEBASE_MEN,
  },
  { key: 'winGoal', label: 'win expected', includes: (puzzle) => puzzle.goal === 'win' },
  { key: 'drawGoal', label: 'draw expected', includes: (puzzle) => puzzle.goal === 'draw' },
]

export function buildReport(
  measurements: PuzzleMeasurement[],
  config: PlayoutReportConfig,
): YamlValue {
  const summary = Object.fromEntries(
    REPORT_GROUPS.map((group) => [
      group.key,
      summarizeGroup(measurements.filter((m) => group.includes(m.puzzle))),
    ]),
  )
  return {
    generatedAt: new Date().toISOString(),
    config: { ...config },
    defenderMoveTimeMs: moveTimeSummary(moveTimesOf(measurements)),
    summary,
    puzzles: measurements.map((measurement) => {
      const score = scorePuzzle(measurement)
      return {
        fen: measurement.puzzle.fen,
        category: measurement.puzzle.categoryPath,
        goal: measurement.puzzle.goal,
        men: measurement.puzzle.men,
        delayMoves: round(score.delayMoves, 1),
        trickiness: round(score.trickiness),
        earlyTrickiness: round(score.earlyTrickiness),
        combined: round(score.combined, 1),
        avgMoveTimeMs: round(averageMoveTimeMs(measurement), 0),
        playouts: measurement.playouts.map((playout) => ({
          delayMoves: playout.delayMoves,
          trickiness: round(playout.trickiness),
          combined: round(combinedScore(playout.delayMoves, playout.trickiness), 1),
          endReason: playout.endReason,
          avgMoveTimeMs: round(mean(playout.moveTimesMs), 0),
          moves: formatMoveLine(playout.plies),
        })),
      }
    }),
  }
}

export function formatSummary(measurements: PuzzleMeasurement[]): string {
  const rows = REPORT_GROUPS.map((group) => {
    const scores = measurements.filter((m) => group.includes(m.puzzle)).map(scorePuzzle)
    return (
      `  ${group.label.padEnd(26)} n=${String(scores.length).padStart(3)}  ` +
      `delay=${mean(scores.map((s) => s.delayMoves))
        .toFixed(1)
        .padStart(6)}  ` +
      `trickiness=${mean(scores.map((s) => s.trickiness)).toFixed(3)}  ` +
      `early_trickiness=${mean(scores.map((s) => s.earlyTrickiness)).toFixed(3)}  ` +
      `combined=${mean(scores.map((s) => s.combined))
        .toFixed(1)
        .padStart(6)}`
    )
  })
  return [
    'Engine playout measurement',
    ...rows,
    formatMoveTimeLine(moveTimesOf(measurements)),
  ].join('\n')
}

// The live line for one finished puzzle. Deliberately narrower than the baseline row: the
// end reasons and the combined score are in the written report, and what is worth watching
// while a run is in progress is the two numbers the comparison moves.
export function formatPuzzleLine(measurement: PuzzleMeasurement): string {
  const score = scorePuzzle(measurement)
  return (
    `${measurement.puzzle.fen} [${measurement.puzzle.goal}, ${measurement.puzzle.men} men] ` +
    `delay=${score.delayMoves.toFixed(1)} moves  trickiness=${score.trickiness.toFixed(3)}`
  )
}

export interface ReportPaths {
  yamlPath: string
  detailPath: string
}

export function writeReport(
  paths: ReportPaths,
  measurements: PuzzleMeasurement[],
  config: PlayoutReportConfig,
): void {
  writeFileSync(
    paths.yamlPath,
    '# Baseline for the engine-playout measurement — commit it, and compare a later run\n' +
      '# against it to see whether a useMoveSelector change defends better or worse.\n' +
      formatYaml(buildReport(measurements, config)),
  )
  // Per-ply detail is far too large and too churn-prone to commit; it exists to explain a
  // number in the baseline, not to be diffed
  writeFileSync(paths.detailPath, JSON.stringify(measurements, null, 2))
}
