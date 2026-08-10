import { positionKey, withoutRepetitionLoops } from '@/utils/repetitionLoops'
import type { PlayoutEndReason, PlayoutPly, PlayoutResult } from './enginePlayout'

// How far ahead the user must be for the rest of the game to count as a formality, and by
// how much that must exceed where they started — a puzzle that begins a rook up is not
// "converted" by still being a rook up.
const DECISIVE_MATERIAL_BALANCE = 4
const DECISIVE_MATERIAL_GAIN = 4

// The same splice useMoveSelector's rollout delayer scores its rollouts with, over the
// positions this line passed through — the starting position of each ply, plus the one the
// last ply led to
export function withoutPlyRepetitionLoops(plies: PlayoutPly[], finalFen: string): PlayoutPly[] {
  return withoutRepetitionLoops(plies, [
    ...plies.map((ply) => positionKey(ply.fenBefore)),
    positionKey(finalFen),
  ])
}

/**
 * Drops the mopping-up tail: once the user is decisively ahead on material and stays
 * there, the rest is technique nobody needs a training partner for, so the defense that
 * happened after that point shouldn't count toward its score. Cuts the longest suffix in
 * which *every* user-to-move position is decisive, measured against where the puzzle
 * started rather than against zero.
 */
export function withoutConvertedTail(plies: PlayoutPly[]): PlayoutPly[] {
  const userPlies = plies.filter((ply) => ply.side === 'user')
  const startingBalance = userPlies[0]?.userMaterialBalance
  if (startingBalance === undefined) return plies

  const isDecisive = (ply: PlayoutPly): boolean =>
    ply.userMaterialBalance >= DECISIVE_MATERIAL_BALANCE &&
    ply.userMaterialBalance >= startingBalance + DECISIVE_MATERIAL_GAIN

  // Walk back from the end over user plies for as long as they all stay decisive; the cut
  // lands on the first of them, so the position where the user broke through is the last
  // one the defense is credited with reaching
  let cutIndex = plies.length
  for (let i = plies.length - 1; i >= 0; i--) {
    const ply = plies[i]!
    if (ply.side !== 'user') continue
    if (!isDecisive(ply)) break
    cutIndex = i
  }
  return plies.slice(0, cutIndex)
}

export interface TrimmedPlayout {
  plies: PlayoutPly[]
  // How the scored line ends, which is the playout's own end reason unless the converted
  // tail was cut away — then the line ends at the breakthrough, whatever followed it
  endReason: PlayoutEndReason
  // Defender moves the user had to answer before the position was done
  delayMoves: number
  // Mean trickiness of the positions the user actually had to solve
  trickiness: number
}

/**
 * Scores a finished playout, after cutting the parts that shouldn't count. Both cuts only
 * apply to won puzzles: in a draw-goal puzzle repetition is the legitimate way to hold the
 * position, and there is no material breakthrough to convert.
 */
export function trimPlayout(playout: PlayoutResult, goal: string): TrimmedPlayout {
  const withoutLoops =
    goal === 'win' ? withoutPlyRepetitionLoops(playout.plies, playout.finalFen) : playout.plies
  const plies = goal === 'win' ? withoutConvertedTail(withoutLoops) : withoutLoops

  const trickinessValues = plies.flatMap((ply) => (ply.trickiness === null ? [] : [ply.trickiness]))
  return {
    plies,
    endReason: plies.length < withoutLoops.length ? 'material-truncated' : playout.endReason,
    delayMoves: plies.filter((ply) => ply.side === 'defender').length,
    trickiness:
      trickinessValues.length === 0
        ? 0
        : trickinessValues.reduce((sum, value) => sum + value, 0) / trickinessValues.length,
  }
}

// Trickiness scales the delay rather than adding to it: a long defense the user could
// sleepwalk through and a short one full of traps are both worth less than a long tricky
// one, and the product says so in units that still read as "moves".
export function combinedScore(delayMoves: number, trickiness: number): number {
  return delayMoves * (1 + trickiness)
}
