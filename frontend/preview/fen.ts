// FEN parsing for the link-preview Worker. Deliberately standalone rather than reusing
// chess.js from the app: the Worker only needs piece placement and side to move, and
// pulling a move generator into it would cost startup time on every cold isolate.

export type PieceColor = 'w' | 'b'

export interface PlacedPiece {
  // 0 = a-file, 7 = h-file
  file: number
  // 0 = rank 1, 7 = rank 8
  rank: number
  // Piece-set asset code, e.g. 'wK'
  code: string
}

export interface ParsedPosition {
  pieces: PlacedPiece[]
  sideToMove: PieceColor
}

const PIECE_LETTERS = 'pnbrqk'

// A shared link can carry anything; nothing downstream should have to defend itself.
const MAX_FEN_LENGTH = 100

// Shared links write the fen with underscores for spaces (see useAppRouter.ts's
// buildRouteUrl), so both forms have to parse.
export function parseFen(raw: string): ParsedPosition | null {
  if (raw.length === 0 || raw.length > MAX_FEN_LENGTH) return null

  const [placement, side] = raw.replaceAll('_', ' ').split(' ')
  if (placement === undefined) return null

  const ranks = placement.split('/')
  if (ranks.length !== 8) return null

  const pieces: PlacedPiece[] = []
  for (const [index, rankField] of ranks.entries()) {
    // FEN lists rank 8 first
    const rank = 7 - index
    let file = 0
    for (const character of rankField) {
      if (character >= '1' && character <= '8') {
        file += Number(character)
        continue
      }
      const isWhite = character === character.toUpperCase()
      if (!PIECE_LETTERS.includes(character.toLowerCase())) return null
      if (file > 7) return null
      pieces.push({
        file,
        rank,
        code: `${isWhite ? 'w' : 'b'}${character.toUpperCase()}`,
      })
      file += 1
    }
    if (file !== 8) return null
  }

  // Side to move is optional in the wild but decides both the orientation and the
  // preview's title, so a fen without it is not something we want to render.
  if (side !== 'w' && side !== 'b') return null

  return { pieces, sideToMove: side }
}

// The entire preview title: the Function has no access to the puzzle catalog, so it
// knows nothing about the position beyond what the fen says.
export function describeSideToMove(position: ParsedPosition): string {
  return position.sideToMove === 'w' ? 'White to play' : 'Black to play'
}
