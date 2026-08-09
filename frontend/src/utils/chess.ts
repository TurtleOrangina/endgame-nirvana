import { Chess } from 'chess.js'
import type { PlayerColor } from '@/types'

const FIGURINES: Record<string, string> = {
  K: '♔',
  Q: '♕',
  R: '♖',
  B: '♗',
  N: '♘',
}

export function toFigurineSan(san: string): string {
  return san.replace(/^[KQRBN]/, (c) => FIGURINES[c] ?? c)
}

export type PieceName = 'king' | 'queen' | 'rook' | 'bishop' | 'knight' | 'pawn'

const PIECE_VALUE_ORDER = ['k', 'q', 'r', 'b', 'n', 'p']
const PIECE_NAMES_BY_LETTER: Record<string, PieceName> = {
  k: 'king',
  q: 'queen',
  r: 'rook',
  b: 'bishop',
  n: 'knight',
  p: 'pawn',
}

export function playerPiecesSortedByValue(fen: string, color: PlayerColor): PieceName[] {
  return [...piecesByColor(fen)[color]]
    .sort((a, b) => PIECE_VALUE_ORDER.indexOf(a) - PIECE_VALUE_ORDER.indexOf(b))
    .map((letter) => PIECE_NAMES_BY_LETTER[letter])
    .filter((name): name is PieceName => !!name)
}

export function uciToMoveArgs(uci: string): {
  from: string
  to: string
  promotion: 'q' | 'r' | 'n' | 'b' | undefined
} {
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci[4] as 'q' | 'r' | 'n' | 'b' | undefined,
  }
}

export function piecesByColor(fen: string): { white: string[]; black: string[] } {
  const board = (fen.split(' ')[0] ?? '').replace(/[0-9/]/g, '')
  const white: string[] = []
  const black: string[] = []
  for (const piece of board) {
    if (piece === piece.toUpperCase()) white.push(piece.toLowerCase())
    else black.push(piece)
  }
  return { white, black }
}

export function hasPawnsOnBoard(fen: string): boolean {
  const { white, black } = piecesByColor(fen)
  return white.includes('p') || black.includes('p')
}

export const PIECE_VALUE: Record<string, number> = { q: 9, r: 5, b: 3, n: 3, p: 1 }

export function materialByColor(fen: string): { white: number; black: number } {
  const { white, black } = piecesByColor(fen)
  const sumValues = (pieces: string[]): number =>
    pieces.reduce((sum, piece) => sum + (PIECE_VALUE[piece] ?? 0), 0)
  return { white: sumValues(white), black: sumValues(black) }
}

// Below this rating, converting a bare-king-vs-major-piece material edge isn't
// trivial yet, so it shouldn't be treated as an automatic win.
export const MIN_ELO_MAJOR_PIECE_VS_KING_IS_WON = 1000

// True when the opponent is down to a bare king and the player holds at least one queen
// or rook (any other material on either side, e.g. extra pawns/minors, doesn't matter).
export function isBareKingVsMajorPiece(fen: string, playerColor: PlayerColor): boolean {
  const { white, black } = piecesByColor(fen)
  const playerPieces = playerColor === 'white' ? white : black
  const opponentPieces = playerColor === 'white' ? black : white
  const opponentIsBareKing = opponentPieces.length === 1 && opponentPieces[0] === 'k'
  const playerHasMajorPiece = playerPieces.includes('q') || playerPieces.includes('r')
  return opponentIsBareKing && playerHasMajorPiece
}

// True when the opponent could not checkmate even with the player's cooperation: their
// material alone (bare king, king and a single minor piece) is insufficient to mate. The
// player's own material is irrelevant to that, so it is stripped down to a bare king
// before asking chess.js — a K+N vs K+R position is unmateable for the knight's side just
// the same as K+N vs K.
export function isOpponentUnableToCheckmate(fen: string, playerColor: PlayerColor): boolean {
  const position = new Chess(fen)
  const playerPieceColor = playerColor === 'white' ? 'w' : 'b'
  for (const square of position.board().flat()) {
    if (square && square.color === playerPieceColor && square.type !== 'k') {
      position.remove(square.square)
    }
  }
  return position.isInsufficientMaterial()
}

// True when both sides hold the same, pawnless material — e.g. rook and bishop against
// rook and bishop, or bishop against bishop. Such a position is dead drawn by itself:
// with no pawns there is nothing left to promote and neither side can make progress.
// Bishops and knights are treated as one and the same minor piece, so rook and bishop
// against rook and knight counts as mirrored too.
export function isMirroredPawnlessEndgame(fen: string): boolean {
  const { white, black } = piecesByColor(fen)
  if (white.includes('p') || black.includes('p')) return false
  const asMaterialSignature = (pieces: string[]): string =>
    pieces
      .map((piece) => (piece === 'b' || piece === 'n' ? 'm' : piece))
      .sort()
      .join('')
  return asMaterialSignature(white) === asMaterialSignature(black)
}

export function uciLineToPretty(fen: string, uciMoves: string[]): string[] {
  // Normalize fullmove number to 1 so every puzzle line starts at move 1
  const parts = fen.split(' ')
  parts[5] = '1'
  const chess = new Chess(parts.join(' '))
  const result: string[] = []
  let needsBlackEllipsis = chess.turn() === 'b'

  for (const uci of uciMoves) {
    try {
      const turn = chess.turn()
      const moveNum = chess.moveNumber()
      const move = chess.move(uciToMoveArgs(uci))
      if (turn === 'w') {
        result.push(`${moveNum}.`)
      } else if (needsBlackEllipsis) {
        result.push(`${moveNum}...`)
        needsBlackEllipsis = false
      }
      result.push(toFigurineSan(move.san))
    } catch {
      break
    }
  }
  return result
}
