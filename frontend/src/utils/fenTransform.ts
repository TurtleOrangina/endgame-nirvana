export type FenTransformation = 'identity' | 'swapAndFlip' | 'mirrorFiles' | 'both'

function expandRank(rank: string): string[] {
  const cells: string[] = []
  for (const ch of rank) {
    if (/\d/.test(ch)) {
      for (let i = 0; i < parseInt(ch); i++) cells.push('.')
    } else {
      cells.push(ch)
    }
  }
  return cells
}

function compactRank(cells: string[]): string {
  let result = ''
  let empty = 0
  for (const cell of cells) {
    if (cell === '.') {
      empty++
    } else {
      if (empty > 0) {
        result += empty
        empty = 0
      }
      result += cell
    }
  }
  if (empty > 0) result += empty
  return result
}

function swapPieceCase(piece: string): string {
  return piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase()
}

function swapRankPieceCases(rank: string): string {
  return rank.replace(/[a-zA-Z]/g, swapPieceCase)
}

function swapCastlingRights(castling: string): string {
  if (castling === '-') return '-'
  return castling.replace(/[a-zA-Z]/g, swapPieceCase)
}

function flipEnPassantRank(ep: string): string {
  if (ep === '-') return '-'
  return `${ep[0]}${9 - parseInt(ep[1]!)}`
}

function mirrorEnPassantFile(ep: string): string {
  if (ep === '-') return '-'
  const mirroredFile = String.fromCharCode(97 + 7 - (ep.charCodeAt(0) - 97))
  return `${mirroredFile}${ep[1]}`
}

function swapColorsAndFlipRanks(fen: string): string {
  const [piecePlacement, activeColor, castling, enPassant, halfmove, fullmove] = fen.split(' ')
  const ranks = (piecePlacement ?? '').split('/')
  const newPiecePlacement = [...ranks].reverse().map(swapRankPieceCases).join('/')
  const newActiveColor = activeColor === 'w' ? 'b' : 'w'
  const newCastling = swapCastlingRights(castling ?? '-')
  const newEnPassant = flipEnPassantRank(enPassant ?? '-')
  return `${newPiecePlacement} ${newActiveColor} ${newCastling} ${newEnPassant} ${halfmove ?? '0'} ${fullmove ?? '1'}`
}

function mirrorFiles(fen: string): string {
  const [piecePlacement, activeColor, castling, enPassant, halfmove, fullmove] = fen.split(' ')
  const ranks = (piecePlacement ?? '').split('/')
  const newPiecePlacement = ranks
    .map((rank) => {
      const cells = expandRank(rank)
      cells.reverse()
      return compactRank(cells)
    })
    .join('/')
  const newEnPassant = mirrorEnPassantFile(enPassant ?? '-')
  return `${newPiecePlacement} ${activeColor ?? 'w'} ${castling ?? '-'} ${newEnPassant} ${halfmove ?? '0'} ${fullmove ?? '1'}`
}

export function hasCastlingRights(fen: string): boolean {
  return (fen.split(' ')[2] ?? '-') !== '-'
}

// All four transformations are self-inverse: applying any twice returns the original.
export function applyTransformation(fen: string, transformation: FenTransformation): string {
  switch (transformation) {
    case 'identity':
      return fen
    case 'swapAndFlip':
      return swapColorsAndFlipRanks(fen)
    case 'mirrorFiles':
      return mirrorFiles(fen)
    case 'both':
      return mirrorFiles(swapColorsAndFlipRanks(fen))
  }
}

export function pickRandomTransformation(fen: string): FenTransformation {
  const options: FenTransformation[] = hasCastlingRights(fen)
    ? ['identity', 'swapAndFlip']
    : ['identity', 'swapAndFlip', 'mirrorFiles', 'both']
  return options[Math.floor(Math.random() * options.length)]!
}

export function findOriginalFen(
  transformedFen: string,
  allOriginalFens: Set<string>,
): string | null {
  const transformations: FenTransformation[] = ['identity', 'swapAndFlip', 'mirrorFiles', 'both']
  for (const t of transformations) {
    const candidate = applyTransformation(transformedFen, t)
    if (allOriginalFens.has(candidate)) return candidate
  }
  return null
}
