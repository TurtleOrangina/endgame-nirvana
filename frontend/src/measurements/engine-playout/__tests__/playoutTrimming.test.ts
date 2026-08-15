// @vitest-environment node
import { describe, expect, test } from 'vite-plus/test'
import {
  combinedScore,
  trimPlayout,
  withoutConvertedTail,
  withoutPlyRepetitionLoops,
} from '../playoutTrimming'
import type { PlayoutPly, PlayoutResult } from '../enginePlayout'

// Only the fields the trimming reads matter; the FEN stands in for a position identity, so
// the tests spell out just the placement field the position key is built from.
function ply(
  side: 'user' | 'defender',
  position: string,
  userMaterialBalance = 0,
  trickiness: number | null = null,
): PlayoutPly {
  return {
    side,
    fenBefore: `${position} ${side === 'user' ? 'w' : 'b'} - - 0 1`,
    san: position,
    userMaterialBalance,
    trickiness: side === 'user' ? trickiness : null,
  }
}

describe('withoutPlyRepetitionLoops', () => {
  test('cuts a loop between the first and last occurrence of a position', () => {
    // Positions A B C D E F C D E H, then a final position I
    const positions = ['A', 'B', 'C', 'D', 'E', 'F', 'C', 'D', 'E', 'H']
    const plies = positions.map((position, index) =>
      ply(index % 2 === 0 ? 'user' : 'defender', position),
    )
    const kept = withoutPlyRepetitionLoops(plies, 'I w - - 0 1')

    // The loop C D E F is gone; everything from the second C onward survives
    expect(kept.map((entry) => entry.san)).toEqual(['A', 'B', 'C', 'D', 'E', 'H'])
  })

  test('leaves a line without repetition untouched', () => {
    const plies = ['A', 'B', 'C'].map((position) => ply('user', position))
    expect(withoutPlyRepetitionLoops(plies, 'D w - - 0 1')).toEqual(plies)
  })

  test('collapses nested loops in repeated passes', () => {
    const positions = ['A', 'B', 'C', 'B', 'D', 'A', 'E']
    const plies = positions.map((position) => ply('user', position))
    expect(withoutPlyRepetitionLoops(plies, 'F w - - 0 1').map((entry) => entry.san)).toEqual([
      'A',
      'E',
    ])
  })
})

describe('withoutConvertedTail', () => {
  test('cuts the suffix where the user is decisively ahead of where they started', () => {
    // Balances at user-to-move positions: +1 +1 +6 +6 — the puzzle started a pawn up, so
    // +6 is both decisive and 5 pawns better than the start
    const balances = [1, 1, 6, 6]
    const plies = balances.flatMap((balance) => [
      ply('user', `P${balance}`, balance),
      ply('defender', `P${balance}`, balance),
    ])
    expect(withoutConvertedTail(plies)).toHaveLength(4)
  })

  test('keeps a line that was already winning at the start', () => {
    // Starting +6 and staying +6 is not a conversion — nothing was won along the way
    const plies = [6, 6, 6].flatMap((balance) => [
      ply('user', 'P', balance),
      ply('defender', 'P', balance),
    ])
    expect(withoutConvertedTail(plies)).toEqual(plies)
  })

  test('keeps a decisive edge that is given back again', () => {
    const balances = [0, 5, 0]
    const plies = balances.map((balance) => ply('user', `P${balance}`, balance))
    expect(withoutConvertedTail(plies)).toEqual(plies)
  })
})

describe('trimPlayout', () => {
  const playout = (plies: PlayoutPly[]): PlayoutResult => ({
    endReason: 'checkmate',
    plies,
    finalFen: 'Z w - - 0 1',
    defenderMoveTimesMs: plies.filter((entry) => entry.side === 'defender').map(() => 400),
    defenderTablebaseLookups: plies.filter((entry) => entry.side === 'defender').map(() => 1),
  })

  test('scores a won playout after cutting the converted tail', () => {
    const plies = [
      ply('user', 'A', 0, 0.5),
      ply('defender', 'A'),
      ply('user', 'B', 6, 0.1),
      ply('defender', 'B'),
    ]
    const trimmed = trimPlayout(playout(plies), 'win')

    expect(trimmed.delayMoves).toBe(1)
    // The trickiness of the cut position goes with it
    expect(trimmed.trickiness).toBe(0.5)
    // How the game ended stopped mattering once the line was cut short of it
    expect(trimmed.endReason).toBe('material-truncated')
  })

  test('keeps the playouts own end reason when nothing was cut for material', () => {
    const plies = [ply('user', 'A', 0, 0.5), ply('defender', 'A')]
    expect(trimPlayout(playout(plies), 'win').endReason).toBe('checkmate')
  })

  test('leaves a drawn playout uncut — repeating is how a draw is held', () => {
    const plies = [
      ply('user', 'A', 0, 0.4),
      ply('defender', 'B'),
      ply('user', 'A', 0, 0.6),
      ply('defender', 'B'),
    ]
    const trimmed = trimPlayout(playout(plies), 'draw')

    expect(trimmed.delayMoves).toBe(2)
    expect(trimmed.trickiness).toBeCloseTo(0.5)
  })
})

describe('combinedScore', () => {
  test('scales the delay by the trickiness', () => {
    expect(combinedScore(30, 0.4)).toBe(42)
    expect(combinedScore(30, 0)).toBe(30)
  })
})
