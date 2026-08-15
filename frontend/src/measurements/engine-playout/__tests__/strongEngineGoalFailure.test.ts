// @vitest-environment node
import { describe, expect, test } from 'vite-plus/test'
import { strongEngineGoalFailure } from '../enginePlayout'
import type { PlayoutEndReason, PlayoutResult } from '../enginePlayout'

// White (the user, since white is to move) is a rook up and winning
const WON_PUZZLE = { fen: '6k1/R4b2/8/6K1/7P/8/8/8 w - - 0 1', goal: 'win' }
const DRAWN_PUZZLE = { fen: '6k1/R4b2/8/6K1/7P/8/8/8 w - - 0 1', goal: 'draw' }

// Only the two fields the verdict reads; the rest of a playout has no say in it
function playout(endReason: PlayoutEndReason, finalFen: string): PlayoutResult {
  return { endReason, finalFen, plies: [], defenderMoveTimesMs: [], defenderTablebaseLookups: [] }
}

// Side to move is the side that stands checkmated
const USER_MATED = '6k1/R4b2/8/6K1/7P/8/8/8 w - - 0 1'
const DEFENDER_MATED = '6k1/R4b2/8/6K1/7P/8/8/8 b - - 0 1'

describe('strongEngineGoalFailure', () => {
  test.each([
    'threefold-repetition',
    'stalemate',
    'insufficient-material',
    'fifty-move-rule',
    'auto-draw',
  ] as const)('flags a won puzzle drawn by %s', (endReason) => {
    expect(strongEngineGoalFailure(WON_PUZZLE, playout(endReason, USER_MATED))).toContain(
      'drew a won position',
    )
  })

  test('says nothing when a won puzzle is won', () => {
    expect(strongEngineGoalFailure(WON_PUZZLE, playout('auto-win', USER_MATED))).toBeNull()
    expect(strongEngineGoalFailure(WON_PUZZLE, playout('checkmate', DEFENDER_MATED))).toBeNull()
  })

  test('flags the user being checkmated, whatever the goal was', () => {
    expect(strongEngineGoalFailure(WON_PUZZLE, playout('checkmate', USER_MATED))).toBe(
      'was checkmated',
    )
    expect(strongEngineGoalFailure(DRAWN_PUZZLE, playout('checkmate', USER_MATED))).toBe(
      'was checkmated',
    )
  })

  test('leaves a draw-goal puzzle alone when it is drawn — that is the goal', () => {
    expect(
      strongEngineGoalFailure(DRAWN_PUZZLE, playout('threefold-repetition', USER_MATED)),
    ).toBeNull()
    expect(strongEngineGoalFailure(DRAWN_PUZZLE, playout('auto-draw', USER_MATED))).toBeNull()
  })

  test('flags a won puzzle that never got converted', () => {
    expect(strongEngineGoalFailure(WON_PUZZLE, playout('ply-limit-reached', USER_MATED))).toContain(
      'never converted',
    )
    expect(
      strongEngineGoalFailure(WON_PUZZLE, playout('selector-gave-no-move', USER_MATED)),
    ).toContain('no move')
  })

  test('reads the mated side from the final position, not the puzzle', () => {
    // Black to move in the puzzle, so black is the user; white is the one mated here
    const blackToMove = { fen: '6k1/R4b2/8/6K1/7P/8/8/8 b - - 0 1', goal: 'win' }
    expect(strongEngineGoalFailure(blackToMove, playout('checkmate', DEFENDER_MATED))).toBe(
      'was checkmated',
    )
    expect(strongEngineGoalFailure(blackToMove, playout('checkmate', USER_MATED))).toBeNull()
  })
})
