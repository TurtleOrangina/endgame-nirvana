import { Chess, type Move } from 'chess.js'
import type { EngineLine, GameResult } from '@/types'
import { scoreToOutcome } from '@/utils/puzzleEvaluation'
import { uciToMoveArgs } from '@/utils/chess'

// Weight of a non-maintaining move whose engine refutation is an immediate checkmate or
// an immediate capture no maintaining line allows — a blunder that obvious barely dilutes
// the position's trickiness, since even a careless user would spot the refutation
const OBVIOUS_BLUNDER_WEIGHT = 0.1

// Never report a position as trickier than this, no matter how few moves hold: a
// position where everything loses is not a trap the user can be led into
const MIN_MAINTAIN_FRACTION = 0.35

/**
 * Weighted fraction of the user's legal moves that keep the outcome best play would
 * achieve, estimated from a wide (MultiPV 64) shallow engine search. With so few pieces
 * on the board this covers essentially every legal move. When the user is winning, only
 * moves that keep the win maintain — e.g. blundering into stalemate drops it; when
 * drawing, anything that isn't lost does. Moves are weighted by how likely the user is
 * to consider them: non-maintaining moves refuted by an obvious reply count far less,
 * while maintaining moves that are checks or captures count more — the fewer legal
 * checks/captures there are to sift through, the easier the move is to spot.
 *
 * Shared by useMoveSelector's Trickster (which steers *toward* low fractions) and the
 * engine-playout measurement (which reports `1 - fraction` as achieved trickiness), so
 * the two can never disagree about what "tricky" means.
 */
export function engineMaintainFraction(
  probedFen: string,
  lines: EngineLine[],
  userOutcomeWithBestPlay: GameResult,
): number {
  if (lines.length === 0) return 1
  const maintainsOutcome = (line: EngineLine): boolean => {
    const outcome = scoreToOutcome(line.scoreCP, line.scoreMate)
    return userOutcomeWithBestPlay === 'win' ? outcome === 'win' : outcome !== 'loss'
  }

  const isCheck = (move: Move): boolean => move.san.includes('+') || move.san.includes('#')
  const isCapture = (move: Move): boolean => move.isCapture() || move.isEnPassant()
  const legalMoves = new Chess(probedFen).moves({ verbose: true })
  const legalCheckCount = legalMoves.filter(isCheck).length
  const legalCaptureCount = legalMoves.filter(isCapture).length
  const maintainingLineResponses = new Set(
    lines
      .filter(maintainsOutcome)
      .flatMap((line) => (line.moves[1] !== undefined ? [line.moves[1]] : [])),
  )

  // Checks and captures are what the user calculates first, so a maintaining one is
  // easier to find than a quiet move — the more so the fewer there are to sift through
  const maintainingMoveWeight = (uci: string): number => {
    const move = legalMoves.find((m) => m.from + m.to + (m.promotion ?? '') === uci)
    if (!move) return 1
    let weight = 1
    if (isCheck(move)) weight = Math.max(weight, 1 + 1 / legalCheckCount)
    if (isCapture(move)) weight = Math.max(weight, 1 + 1 / legalCaptureCount)
    return weight
  }

  // A faulty move refuted by an immediate mate, or by an immediate capture that no
  // maintaining line concedes anyway, is a one-move blunder the user would hardly play
  const faultyMoveWeight = (line: EngineLine): number => {
    const responseUci = line.moves[1]
    if (responseUci === undefined) return 1
    const chess = new Chess(probedFen)
    let response: Move
    try {
      chess.move(uciToMoveArgs(line.moves[0]!))
      response = chess.move(uciToMoveArgs(responseUci))
    } catch {
      return 1
    }
    const isMateBlunder = chess.isCheckmate()
    const isMaterialBlunder = isCapture(response) && !maintainingLineResponses.has(responseUci)
    return isMateBlunder || isMaterialBlunder ? OBVIOUS_BLUNDER_WEIGHT : 1
  }

  let maintainingWeight = 0
  let totalWeight = 0
  for (const line of lines) {
    const weight = maintainsOutcome(line)
      ? maintainingMoveWeight(line.moves[0]!)
      : faultyMoveWeight(line)
    if (maintainsOutcome(line)) maintainingWeight += weight
    totalWeight += weight
  }
  return Math.max(MIN_MAINTAIN_FRACTION, maintainingWeight / totalWeight)
}

// The highest trickiness `1 - engineMaintainFraction(...)` can report
export const MAX_TRICKINESS = 1 - MIN_MAINTAIN_FRACTION
