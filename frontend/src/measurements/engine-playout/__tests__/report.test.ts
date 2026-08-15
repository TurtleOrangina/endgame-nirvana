// @vitest-environment node
import { describe, expect, test } from 'vite-plus/test'
import { buildReport, formatMoveLine, formatSummary, type PuzzleMeasurement } from '../report'
import { formatYaml, parseMappingList } from '../yaml'
import type { PlayoutPly } from '../enginePlayout'

function ply(san: string, turn: 'w' | 'b'): PlayoutPly {
  return {
    side: turn === 'w' ? 'user' : 'defender',
    fenBefore: `8/8/8/8/8/8/8/8 ${turn} - - 0 1`,
    san,
    userMaterialBalance: 0,
    trickiness: turn === 'w' ? 0.5 : null,
  }
}

const measurement: PuzzleMeasurement = {
  puzzle: {
    fen: '8/7p/6p1/6P1/5P1P/2k1p3/8/3K4 w - - 0 1',
    categoryPath: '/Pawn Endgames',
    goal: 'win',
    difficulty: 1500,
    men: 8,
  },
  playouts: [
    {
      endReason: 'auto-win',
      delayMoves: 2,
      trickiness: 0.25,
      plies: [ply('f5', 'w'), ply('Kb2', 'b'), ply('fxg6', 'w'), ply('Ka1', 'b')],
      moveTimesMs: [400, 500],
      tablebaseLookupsPerMove: [3, 0],
    },
    {
      endReason: 'material-truncated',
      delayMoves: 1,
      trickiness: 0.5,
      plies: [ply('f5', 'w'), ply('Kb2', 'b')],
      moveTimesMs: [900],
      tablebaseLookupsPerMove: [2],
    },
  ],
}

const config = {
  defender: 'move-selector',
  temperature: 'minimum',
  puzzleSet: 'engine-playout-puzzles.yaml',
  seed: 1,
  playoutsPerPuzzle: 2,
  defenderThreads: 8,
  strongEngineThreads: 24,
  userMoveThinkingTimeMs: 400,
  trickinessThinkingTimeMs: 200,
} as const

// buildReport returns the YAML document as a value tree; the tests read named groups out of
// it, which needs the shape spelled out once
interface Distribution {
  n: number
  mean: number
  sd: number
  sem: number
}
interface GroupSummary {
  puzzles: number
  delayMoves?: Distribution
  combined?: Distribution
  trickiness: Distribution
  earlyTrickiness: Distribution
}
interface SplitSummary {
  all: GroupSummary
  moreThanSixMen: GroupSummary
  sixOrLessMen: GroupSummary
}

function summaryOf(measurements: PuzzleMeasurement[]): {
  all: GroupSummary
  winGoal: SplitSummary
  drawGoal: SplitSummary
} {
  return (
    buildReport(measurements, config) as unknown as {
      summary: { all: GroupSummary; winGoal: SplitSummary; drawGoal: SplitSummary }
    }
  ).summary
}

describe('formatMoveLine', () => {
  test('numbers the line from 1 regardless of the FENs move numbers', () => {
    expect(formatMoveLine(measurement.playouts[0]!.plies)).toBe('1. f5 Kb2 2. fxg6 Ka1')
  })

  test('marks a line that starts with a black move', () => {
    expect(formatMoveLine([ply('Kb2', 'b'), ply('f5', 'w')])).toBe('1... Kb2 2. f5')
  })

  test('is empty for a line trimmed down to nothing', () => {
    expect(formatMoveLine([])).toBe('')
  })
})

// A drawn hold of five men, so the summary has one puzzle on each side of both splits
const drawMeasurement: PuzzleMeasurement = {
  puzzle: {
    fen: '8/8/8/8/8/5k2/5p2/5K2 w - - 0 1',
    categoryPath: '/Pawn Endgames',
    goal: 'draw',
    difficulty: 1500,
    men: 5,
  },
  playouts: [
    {
      endReason: 'threefold-repetition',
      delayMoves: 30,
      trickiness: 0.4,
      plies: [ply('Kg1', 'w'), ply('Kg3', 'b')],
      moveTimesMs: [300],
      tablebaseLookupsPerMove: [1],
    },
  ],
}

describe('the summary split', () => {
  const both = [measurement, drawMeasurement]

  test('splits on the goal first and the size second', () => {
    const summary = summaryOf(both)

    expect(Object.keys(summary)).toEqual(['all', 'winGoal', 'drawGoal'])
    expect(Object.keys(summary.winGoal)).toEqual(['all', 'moreThanSixMen', 'sixOrLessMen'])
    expect(summary.winGoal.moreThanSixMen.puzzles).toBe(1)
    expect(summary.winGoal.sixOrLessMen.puzzles).toBe(0)
    expect(summary.drawGoal.sixOrLessMen.puzzles).toBe(1)
  })

  test('reports no delay and no combined score on draw goals', () => {
    const { drawGoal } = summaryOf(both)

    expect(drawGoal.all).not.toHaveProperty('delayMoves')
    expect(drawGoal.all).not.toHaveProperty('combined')
    expect(drawGoal.all.trickiness.mean).toBe(0.4)
  })

  test('takes the all-puzzles delay from the win goals alone, and says over how many', () => {
    const { all } = summaryOf(both)

    // The draw would drag a mixed delay to 15.75; the win puzzle alone averages 1.5
    expect(all.delayMoves).toEqual({ n: 1, mean: 1.5, sd: 0, sem: 0 })
    expect(all.trickiness.n).toBe(2)
    expect(all.puzzles).toBe(2)
  })

  test('leaves the delay columns blank on draw rows of the console summary', () => {
    const lines = formatSummary(both).split('\n')
    const drawRow = lines.find((line) => line.includes('draw expected ')) ?? ''

    expect(drawRow).toContain('trickiness=0.400')
    expect(drawRow).not.toContain('delay=')
  })

  test('reports how much tablebase the defender actually had', () => {
    expect(formatSummary(both)).toContain('tablebase: 75% of defender moves')
    expect(formatYaml(buildReport(both, config))).toContain(
      'tablebase: { movesWithLookupPct: 75, lookupsPerPlayout: 2, lookups: 6 }',
    )
  })
})

describe('buildReport', () => {
  test('lists every playout with its own score, end reason and moves', () => {
    const yaml = formatYaml(buildReport([measurement], config))

    expect(yaml).toContain(
      '{ delayMoves: 2, trickiness: 0.25, combined: 2.5, endReason: "auto-win", ' +
        'avgMoveTimeMs: 450, tablebaseMovesPct: 50, tablebaseLookups: 3, ' +
        'moves: "1. f5 Kb2 2. fxg6 Ka1" }',
    )
    expect(yaml).toContain('endReason: "material-truncated"')
  })

  test('summarizes what the defender cost over every move it produced', () => {
    // 400, 500 and 900 ms: mean 600, population sd 216.02
    expect(formatYaml(buildReport([measurement], config))).toContain(
      'defenderMoveTimeMs: { moves: 3, min: 400, mean: 600, max: 900, sd: 216 }',
    )
    expect(formatSummary([measurement])).toContain(
      'move_time min/avg/max/stddev: 400/600/900/216 ms  (n=3)',
    )
  })

  test('keeps the per-puzzle scalars parseable for the paired comparison', () => {
    const yaml = formatYaml(buildReport([measurement], config))
    const rows = parseMappingList(yaml, 'puzzles')

    // The nested playouts are skipped: only the puzzle's own aggregates come back
    expect(rows).toEqual([
      {
        fen: measurement.puzzle.fen,
        category: '/Pawn Endgames',
        goal: 'win',
        men: 8,
        delayMoves: 1.5,
        trickiness: 0.375,
        // Length-controlled, so it is recomputed from the plies rather than read off the
        // playout's own trickiness — every user ply in this fixture scores 0.5
        earlyTrickiness: 0.5,
        combined: 2.1,
        // On the puzzle itself, not only inside its playouts, so the in-flight comparison
        // can pair thinking time the same way it pairs the scores
        avgMoveTimeMs: 600,
        // Two of the three defender moves consulted the tablebase, over 5 lookups in 2 playouts
        tablebaseMovesPct: 67,
        tablebaseLookups: 2.5,
      },
    ])
  })
})
