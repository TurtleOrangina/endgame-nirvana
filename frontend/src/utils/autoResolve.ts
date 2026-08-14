import { Chess, type Move } from 'chess.js'
import type { MoveSelectionResult } from '@/composables/useMoveSelector'
import { evaluatePuzzleGoal } from '@/utils/puzzleEvaluation'
import {
  isBareKingVsMajorPiece,
  isMirroredPawnlessEndgame,
  isOpponentUnableToCheckmate,
  MIN_ELO_MAJOR_PIECE_VS_KING_IS_WON,
  uciToMoveArgs,
} from '@/utils/chess'
import type { PlayerColor, TablebaseCategory } from '@/types'

// The board state these verdicts depend on, passed explicitly so they stay pure: the
// board component reads it off its own history and profile store, the engine-playout
// measurement (src/measurements/engine-playout/) off its playout record.
export interface AutoResolveContext {
  playerColor: PlayerColor
  // The position the puzzle started from — a material edge that was there all along is
  // not an edge the player just won
  initialFen: string | undefined
  // Falls back to the puzzle's own Elo when the player has no profile yet (guest mode)
  userElo: number
}

// Auto-solves as a win once the position has been reduced to a trivial mating
// material advantage (bare king vs. at least one queen or rook), but only if the
// player is genuinely winning right now and this material edge wasn't already
// present when the puzzle started (otherwise every move of an already-KQK/KRK
// puzzle would instantly auto-solve).
export function isAutoWin(
  fen: string,
  goal: string | undefined,
  scoreCP: number | null,
  scoreMate: number | null,
  tablebaseCategory: TablebaseCategory | null,
  context: AutoResolveContext,
): boolean {
  if (goal !== 'win') return false
  if (context.userElo <= MIN_ELO_MAJOR_PIECE_VS_KING_IS_WON) return false
  if (evaluatePuzzleGoal('win', scoreCP, scoreMate, tablebaseCategory).isOutsideGoal) return false
  if (context.initialFen && isBareKingVsMajorPiece(context.initialFen, context.playerColor)) {
    return false
  }
  return isBareKingVsMajorPiece(fen, context.playerColor)
}

// How far into the computer's intended line the draw auto-solve looks for a reason to
// keep playing: the move it is about to play and the user reply the engine predicts.
const AUTO_DRAW_LOOKAHEAD_HALFMOVES = 2

// Whether the given half-moves change nothing that's worth watching on the board: no
// capture and no game end along the way. An illegal (e.g. truncated) line counts as
// eventful, so a line that can't be verified never triggers the auto-solve.
function isUneventfulContinuation(fen: string, uciMoves: string[]): boolean {
  const chess = new Chess(fen)
  for (const uci of uciMoves.slice(0, AUTO_DRAW_LOOKAHEAD_HALFMOVES)) {
    let move: Move
    try {
      move = chess.move(uciToMoveArgs(uci))
    } catch {
      return false
    }
    if (move.isCapture() || move.isEnPassant()) return false
    if (chess.isGameOver()) return false
  }
  return true
}

// Auto-solves as a draw once a draw-goal puzzle has reached material that can't be won
// against: the computer left without the material to mate at all (see
// isOpponentUnableToCheckmate), or the same pawnless material on both sides (see
// isMirroredPawnlessEndgame). The position holds itself, so playing on is shuffling.
// Held back while something is still about to happen — a capture would change the
// material this verdict rests on, and a stalemate or 50-move end within the next two
// half-moves is the actual end of the game, which the player should see played out.
export function isAutoDraw(
  fen: string,
  goal: string | undefined,
  selection: MoveSelectionResult,
  context: AutoResolveContext,
): boolean {
  if (goal !== 'draw') return false
  if (!isOpponentUnableToCheckmate(fen, context.playerColor) && !isMirroredPawnlessEndgame(fen)) {
    return false
  }
  const { isOutsideGoal } = evaluatePuzzleGoal(
    'draw',
    selection.scoreCP,
    selection.scoreMate,
    selection.tbData?.category ?? null,
  )
  if (isOutsideGoal) return false

  // The line of the move the computer is actually about to play — a capture in it is one
  // the player would see land on the board, not a hypothetical from some other candidate
  const intendedMoves = selection.selectedLine?.moves ?? []
  if (intendedMoves.length === 0) return false
  return isUneventfulContinuation(fen, intendedMoves)
}
