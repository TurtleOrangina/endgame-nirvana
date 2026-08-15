import { writeFileSync } from 'node:fs'
import { summarize } from '@/measurements/shared/statistics'
import { formatYaml, type YamlValue } from './yaml'
import type { PlayoutPuzzle } from './playoutPuzzleSelection'
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
    // Distinct tablebase positions consulted per defender move, one entry per move
    tablebaseLookupsPerMove: number[]
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

/**
 * How much tablebase the defender actually had: the share of its moves it consulted the
 * tablebase for at all, and how many distinct positions that cost per playout. A defender
 * whose tablebase access silently broke — a changed URL, an offline run, a rate limit it
 * never recovered from — is a different opponent from the one users face, and would
 * otherwise only show up as a mysteriously worse score.
 */
interface TablebaseUsage {
  movesWithLookup: number
  moves: number
  lookups: number
  playouts: number
}

function tablebaseUsageOf(measurements: PuzzleMeasurement[]): TablebaseUsage {
  const usage: TablebaseUsage = { movesWithLookup: 0, moves: 0, lookups: 0, playouts: 0 }
  for (const measurement of measurements) {
    for (const playout of measurement.playouts) {
      usage.playouts++
      for (const lookups of playout.tablebaseLookupsPerMove) {
        usage.moves++
        usage.lookups += lookups
        if (lookups > 0) usage.movesWithLookup++
      }
    }
  }
  return usage
}

function tablebaseMovePercent(usage: TablebaseUsage): number {
  return usage.moves === 0 ? 0 : (100 * usage.movesWithLookup) / usage.moves
}

function lookupsPerPlayout(usage: TablebaseUsage): number {
  return usage.playouts === 0 ? 0 : usage.lookups / usage.playouts
}

function tablebaseSummary(usage: TablebaseUsage): YamlValue {
  return {
    movesWithLookupPct: round(tablebaseMovePercent(usage), 1),
    lookupsPerPlayout: round(lookupsPerPlayout(usage), 1),
    lookups: usage.lookups,
  }
}

function formatTablebaseLine(measurements: PuzzleMeasurement[]): string {
  const usage = tablebaseUsageOf(measurements)
  return (
    `  tablebase: ${tablebaseMovePercent(usage).toFixed(0)}% of defender moves, ` +
    `${lookupsPerPlayout(usage).toFixed(1)} lookups per playout ` +
    `(${usage.lookups} total over ${usage.playouts} playouts)`
  )
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
    n: values.length,
    mean: round(average),
    sd: round(stdDev),
    sem: values.length === 0 ? 0 : round(stdDev / Math.sqrt(values.length)),
  }
}

/**
 * Delay is only reported for win goals.
 *
 * On a draw goal it is not a thing to maximize: a hold the user is made to sit through for
 * longer is not better training, only one that keeps testing them for a weakness is. Making
 * draw delay visible invites optimizing it, and the combined score — delay scaled by
 * trickiness — inherits the same problem, so both are left out and the draw groups are judged
 * on trickiness alone.
 */
function summarizeGroup(measurements: PuzzleMeasurement[], delayFrom: PuzzleMeasurement[]) {
  const scores = measurements.map(scorePuzzle)
  const delayScores = delayFrom.map(scorePuzzle)
  return {
    puzzles: measurements.length,
    ...(delayFrom.length === 0
      ? {}
      : {
          delayMoves: distribution(delayScores.map((score) => score.delayMoves)),
          combined: distribution(delayScores.map((score) => score.combined)),
        }),
    trickiness: distribution(scores.map((score) => score.trickiness)),
    earlyTrickiness: distribution(scores.map((score) => score.earlyTrickiness)),
  }
}

// The size split the report groups by. Deliberately not MAX_TABLEBASE_MEN: this one is about
// how much material is on the board, and 7-men positions belong with the big ones for that
// question even though a tablebase still settles them.
export const REPORT_MEN_THRESHOLD = 6

interface ReportGroup {
  key: string
  label: string
  includes: (puzzle: PlayoutPuzzle) => boolean
  // Draw goals report no delay and no combined score — see summarizeGroup
  reportsDelay: boolean
}

function sizeSubgroups(parent: ReportGroup): ReportGroup[] {
  return [
    {
      ...parent,
      key: 'moreThanSixMen',
      label: `${parent.label}, >${REPORT_MEN_THRESHOLD} men`,
      includes: (puzzle) => parent.includes(puzzle) && puzzle.men > REPORT_MEN_THRESHOLD,
    },
    {
      ...parent,
      key: 'sixOrLessMen',
      label: `${parent.label}, ≤${REPORT_MEN_THRESHOLD} men`,
      includes: (puzzle) => parent.includes(puzzle) && puzzle.men <= REPORT_MEN_THRESHOLD,
    },
  ]
}

// Goal first, size second: what a defender should do differs far more between holding a draw
// and dragging out a loss than between a big position and a small one.
const WIN_GOAL: ReportGroup = {
  key: 'winGoal',
  label: 'win expected',
  includes: (puzzle) => puzzle.goal === 'win',
  reportsDelay: true,
}
const DRAW_GOAL: ReportGroup = {
  key: 'drawGoal',
  label: 'draw expected',
  includes: (puzzle) => puzzle.goal === 'draw',
  reportsDelay: false,
}

// `all` mixes the two goals, so its trickiness spans every puzzle while its delay and
// combined score still come from the win goals alone. Each figure carries its own `n`.
export const ALL_PUZZLES: ReportGroup = {
  key: 'all',
  label: 'all puzzles',
  includes: () => true,
  reportsDelay: true,
}

export const REPORT_GROUPS: { group: ReportGroup; subgroups: ReportGroup[] }[] = [
  { group: ALL_PUZZLES, subgroups: [] },
  { group: WIN_GOAL, subgroups: sizeSubgroups(WIN_GOAL) },
  { group: DRAW_GOAL, subgroups: sizeSubgroups(DRAW_GOAL) },
]

// The rows a console summary prints, parent groups followed by their size splits
export const FLATTENED_REPORT_GROUPS: ReportGroup[] = REPORT_GROUPS.flatMap(
  ({ group, subgroups }) => [group, ...subgroups],
)

// The puzzles a group's delay figure averages over: its own, minus the draw goals, which
// have no delay worth reporting
function delaySourceOf(group: ReportGroup, measurements: PuzzleMeasurement[]): PuzzleMeasurement[] {
  if (!group.reportsDelay) return []
  return measurements.filter((measurement) => WIN_GOAL.includes(measurement.puzzle))
}

export function buildReport(
  measurements: PuzzleMeasurement[],
  config: PlayoutReportConfig,
): YamlValue {
  const summarizeFor = (group: ReportGroup): YamlValue => {
    const rows = measurements.filter((measurement) => group.includes(measurement.puzzle))
    return summarizeGroup(rows, delaySourceOf(group, rows))
  }
  const summary = Object.fromEntries(
    REPORT_GROUPS.map(({ group, subgroups }) => [
      group.key,
      subgroups.length === 0
        ? summarizeFor(group)
        : {
            all: summarizeFor(group),
            ...Object.fromEntries(
              subgroups.map((subgroup) => [subgroup.key, summarizeFor(subgroup)]),
            ),
          },
    ]),
  )
  return {
    generatedAt: new Date().toISOString(),
    config: { ...config },
    defenderMoveTimeMs: moveTimeSummary(moveTimesOf(measurements)),
    tablebase: tablebaseSummary(tablebaseUsageOf(measurements)),
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
        tablebaseMovesPct: round(tablebaseMovePercent(tablebaseUsageOf([measurement])), 0),
        tablebaseLookups: round(lookupsPerPlayout(tablebaseUsageOf([measurement])), 1),
        playouts: measurement.playouts.map((playout) => {
          const usage = tablebaseUsageOf([{ puzzle: measurement.puzzle, playouts: [playout] }])
          return {
            delayMoves: playout.delayMoves,
            trickiness: round(playout.trickiness),
            combined: round(combinedScore(playout.delayMoves, playout.trickiness), 1),
            endReason: playout.endReason,
            avgMoveTimeMs: round(mean(playout.moveTimesMs), 0),
            tablebaseMovesPct: round(tablebaseMovePercent(usage), 0),
            tablebaseLookups: usage.lookups,
            moves: formatMoveLine(playout.plies),
          }
        }),
      }
    }),
  }
}

export function formatSummary(measurements: PuzzleMeasurement[]): string {
  const rows = FLATTENED_REPORT_GROUPS.map((group) => {
    const rowMeasurements = measurements.filter((m) => group.includes(m.puzzle))
    const scores = rowMeasurements.map(scorePuzzle)
    const delayScores = delaySourceOf(group, rowMeasurements).map(scorePuzzle)
    // Blank rather than absent where a group reports no delay, so the columns still line up
    const delayColumns =
      delayScores.length === 0
        ? ' '.repeat(30)
        : `delay=${mean(delayScores.map((s) => s.delayMoves))
            .toFixed(1)
            .padStart(6)}  combined=${mean(delayScores.map((s) => s.combined))
            .toFixed(1)
            .padStart(6)}`
    return (
      `  ${group.label.padEnd(26)} n=${String(scores.length).padStart(3)}  ` +
      `trickiness=${mean(scores.map((s) => s.trickiness)).toFixed(3)}  ` +
      `early_trickiness=${mean(scores.map((s) => s.earlyTrickiness)).toFixed(3)}  ` +
      delayColumns
    )
  })
  return [
    'Engine playout measurement',
    ...rows,
    formatMoveTimeLine(moveTimesOf(measurements)),
    formatTablebaseLine(measurements),
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

// The per-ply detail is not written here: it is streamed to the run store as the run goes
// (playoutRunStore.ts), which is also what makes an interrupted run resumable.
export function writeReport(
  yamlPath: string,
  measurements: PuzzleMeasurement[],
  config: PlayoutReportConfig,
): void {
  writeFileSync(
    yamlPath,
    '# Baseline for the engine-playout measurement — commit it, and compare a later run\n' +
      '# against it to see whether a useMoveSelector change defends better or worse.\n' +
      formatYaml(buildReport(measurements, config)),
  )
}
