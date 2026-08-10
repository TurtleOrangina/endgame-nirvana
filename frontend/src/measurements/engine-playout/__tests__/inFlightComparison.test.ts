// @vitest-environment node
import { describe, expect, test } from 'vite-plus/test'
import { formatInFlightComparison, type BaselinePuzzleScore } from '../inFlightComparison'
import type { PuzzleMeasurement } from '../report'

// delayMoves and trickiness are averaged over the playouts, and the move times over every
// move the defender produced, so one playout per puzzle keeps the arithmetic readable
function measurement(
  fen: string,
  goal: string,
  delayMoves: number,
  trickiness: number,
  moveTimeMs: number,
): PuzzleMeasurement {
  return {
    puzzle: { fen, categoryPath: '/x', goal, difficulty: 1500, men: 5 },
    playouts: [
      { endReason: 'auto-win', delayMoves, trickiness, plies: [], moveTimesMs: [moveTimeMs] },
    ],
  }
}

function baseline(
  entries: [string, number, number, number | null][],
): Map<string, BaselinePuzzleScore> {
  return new Map(
    entries.map(([fen, delayMoves, trickiness, avgMoveTimeMs]) => [
      fen,
      { delayMoves, trickiness, avgMoveTimeMs },
    ]),
  )
}

const plain = { color: false } as const
const GREEN = '\u001B[32m'
const RED = '\u001B[31m'
const GRAY = '\u001B[90m'

describe('formatInFlightComparison', () => {
  test('compares against the same puzzles, not the baseline as a whole', () => {
    // 'b' is far slower in the baseline; including it in the average would swamp the real
    // difference on 'a', which is the only puzzle measured so far
    const scores = baseline([
      ['a', 10, 0.4, 700],
      ['b', 40, 0.9, 700],
    ])
    const line = formatInFlightComparison([measurement('a', 'win', 12, 0.45, 750)], scores, plain)
    expect(line).toContain('delay(wins): +2.0')
    expect(line).toContain('trickiness(wins): +0.05')
    expect(line).toContain('thinking_time: +50ms')
  })

  test('keeps win and draw goals apart', () => {
    const scores = baseline([
      ['a', 10, 0.4, 700],
      ['b', 20, 0.6, 700],
    ])
    const line = formatInFlightComparison(
      [measurement('a', 'win', 11.3, 0.38, 700), measurement('b', 'draw', 19.7, 0.65, 700)],
      scores,
      plain,
    )
    expect(line).toBe(
      'In flight comparison vs baseline: delay(wins): +1.3, trickiness(wins): -0.02, ' +
        'delay(draws): -0.3, trickiness(draws): +0.05, thinking_time: +0ms',
    )
  })

  test('names the baseline it was compared against', () => {
    const line = formatInFlightComparison(
      [measurement('a', 'win', 12, 0.45, 750)],
      baseline([['a', 10, 0.4, 700]]),
      { color: false, baselineName: 'engine-playout-baseline.yaml' },
    )
    expect(line).toContain('In flight comparison vs engine-playout-baseline.yaml: delay(wins):')
  })

  test('reports n/a for a goal it has no paired puzzle for yet', () => {
    const line = formatInFlightComparison(
      [measurement('a', 'win', 12, 0.45, 750)],
      baseline([['a', 10, 0.4, 700]]),
      plain,
    )
    expect(line).toContain('delay(draws): n/a')
    expect(line).toContain('trickiness(draws): n/a')
  })

  test('ignores puzzles the baseline does not contain', () => {
    const line = formatInFlightComparison(
      [measurement('a', 'win', 12, 0.45, 750), measurement('unknown', 'win', 99, 0.99, 9999)],
      baseline([['a', 10, 0.4, 700]]),
      plain,
    )
    expect(line).toContain('delay(wins): +2.0')
  })

  test('reports n/a for thinking time against a baseline that predates the field', () => {
    const line = formatInFlightComparison(
      [measurement('a', 'win', 12, 0.45, 750)],
      baseline([['a', 10, 0.4, null]]),
      plain,
    )
    expect(line).toContain('thinking_time: n/a')
    expect(line).toContain('delay(wins): +2.0')
  })

  test('signs a drop in resistance negative', () => {
    const line = formatInFlightComparison(
      [measurement('a', 'win', 8, 0.3, 650)],
      baseline([['a', 10, 0.4, 700]]),
      plain,
    )
    expect(line).toContain('delay(wins): -2.0')
    expect(line).toContain('trickiness(wins): -0.10')
    expect(line).toContain('thinking_time: -50ms')
  })
})

describe('significance colouring', () => {
  // Every puzzle moves the same way by the same amount, so the spread is zero and the
  // difference clears two standard errors comfortably
  const consistent = (delta: number, timeDelta = 0): string =>
    formatInFlightComparison(
      ['a', 'b', 'c', 'd'].map((fen) => measurement(fen, 'win', 10 + delta, 0.4, 700 + timeDelta)),
      baseline(['a', 'b', 'c', 'd'].map((fen) => [fen, 10, 0.4, 700])),
      { color: true },
    )

  test('greens a consistent gain in delay, reds a consistent loss', () => {
    expect(consistent(2)).toContain(`delay(wins): ${GREEN}+2.0`)
    expect(consistent(-2)).toContain(`delay(wins): ${RED}-2.0`)
  })

  test('inverts the sense for thinking time — slower is worse', () => {
    expect(consistent(0, 50)).toContain(`thinking_time: ${RED}+50ms`)
    expect(consistent(0, -50)).toContain(`thinking_time: ${GREEN}-50ms`)
  })

  test('greys a difference that two standard errors cannot separate from zero', () => {
    // Two puzzles moving in opposite directions: a large mean swing, but no real signal
    const line = formatInFlightComparison(
      [measurement('a', 'win', 20, 0.4, 700), measurement('b', 'win', 0, 0.4, 700)],
      baseline([
        ['a', 10, 0.4, 700],
        ['b', 10, 0.4, 700],
      ]),
      { color: true },
    )
    expect(line).toContain(`delay(wins): ${GRAY}+0.0`)
  })

  test('never calls a single puzzle significant, however far it moved', () => {
    const line = formatInFlightComparison(
      [measurement('a', 'win', 99, 0.99, 9999)],
      baseline([['a', 10, 0.4, 700]]),
      { color: true },
    )
    expect(line).toContain(`delay(wins): ${GRAY}+89.0`)
    expect(line).toContain(`thinking_time: ${GRAY}+9299ms`)
  })

  test('emits no escape codes at all when colour is off', () => {
    expect(consistent(2)).toContain(GREEN)
    expect(
      formatInFlightComparison(
        ['a', 'b'].map((fen) => measurement(fen, 'win', 12, 0.4, 700)),
        baseline([
          ['a', 10, 0.4, 700],
          ['b', 10, 0.4, 700],
        ]),
        plain,
      ),
    ).not.toContain('\u001B')
  })
})
