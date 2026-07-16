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

// True for exactly king+rook vs king+rook or king+queen vs king+queen — the symmetric
// major-piece endgames a human player treats as trivially drawn.
export function isSymmetricMajorPieceEndgame(fen: string): boolean {
  const { white, black } = piecesByColor(fen)
  if (white.length !== 2 || black.length !== 2) return false
  const whiteSorted = [...white].sort().join('')
  const blackSorted = [...black].sort().join('')
  return whiteSorted === blackSorted && (whiteSorted === 'kq' || whiteSorted === 'kr')
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
