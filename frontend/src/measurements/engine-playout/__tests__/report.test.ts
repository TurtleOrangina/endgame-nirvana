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
    },
    {
      endReason: 'material-truncated',
      delayMoves: 1,
      trickiness: 0.5,
      plies: [ply('f5', 'w'), ply('Kb2', 'b')],
      moveTimesMs: [900],
    },
  ],
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

describe('buildReport', () => {
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

  test('lists every playout with its own score, end reason and moves', () => {
    const yaml = formatYaml(buildReport([measurement], config))

    expect(yaml).toContain(
      '{ delayMoves: 2, trickiness: 0.25, combined: 2.5, endReason: "auto-win", ' +
        'avgMoveTimeMs: 450, moves: "1. f5 Kb2 2. fxg6 Ka1" }',
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
      },
    ])
  })
})
