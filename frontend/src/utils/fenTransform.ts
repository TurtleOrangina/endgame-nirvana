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

function parseBoardGrid(piecePlacement: string): string[][] {
  return piecePlacement.split('/').map(expandRank)
}

function serializeBoardGrid(grid: string[][]): string {
  return grid.map(compactRank).join('/')
}

function swapPieceCase(piece: string): string {
  return piece === piece.toUpperCase() ? piece.toLowerCase() : piece.toUpperCase()
}

function swapCastlingRights(castling: string): string {
  if (castling === '-') return '-'
  return castling.replace(/[a-zA-Z]/g, swapPieceCase)
}

function mirrorEnPassantFile(ep: string): string {
  if (ep === '-') return '-'
  const mirroredFile = String.fromCharCode(97 + 7 - (ep.charCodeAt(0) - 97))
  return `${mirroredFile}${ep[1]}`
}

function flipEnPassantRank(ep: string): string {
  if (ep === '-') return '-'
  return `${ep[0]}${9 - parseInt(ep[1]!)}`
}

interface FenFields {
  grid: string[][]
  activeColor: string
  castling: string
  enPassant: string
  halfmove: string
  fullmove: string
}

function parseFen(fen: string): FenFields {
  const [piecePlacement, activeColor, castling, enPassant, halfmove, fullmove] = fen.split(' ')
  return {
    grid: parseBoardGrid(piecePlacement ?? ''),
    activeColor: activeColor ?? 'w',
    castling: castling ?? '-',
    enPassant: enPassant ?? '-',
    halfmove: halfmove ?? '0',
    fullmove: fullmove ?? '1',
  }
}

function serializeFen(fields: FenFields): string {
  return `${serializeBoardGrid(fields.grid)} ${fields.activeColor} ${fields.castling} ${fields.enPassant} ${fields.halfmove} ${fields.fullmove}`
}

// Mirror files (left<->right). Legal iff no castling rights (castling side (K/Q)
// isn't remapped by this op).
function applyX(fen: string): string {
  const fields = parseFen(fen)
  fields.grid = fields.grid.map((row) => [...row].reverse())
  fields.enPassant = mirrorEnPassantFile(fields.enPassant)
  return serializeFen(fields)
}

// Mirror ranks (top<->bottom), without recoloring pieces. Legal only when there
// are no pawns (a pawn's forward direction would become inconsistent) and no
// castling rights — which also means en passant is always '-' already here.
function applyY(fen: string): string {
  const fields = parseFen(fen)
  fields.grid = [...fields.grid].reverse()
  return serializeFen(fields)
}

// Rotate the board 90 degrees clockwise. Same legality gating as Y.
function applyR(fen: string): string {
  const fields = parseFen(fen)
  const n = fields.grid.length
  const rotated: string[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => fields.grid[n - 1 - j]?.[i] ?? '.'),
  )
  fields.grid = rotated
  return serializeFen(fields)
}

// Rotate the board 90 degrees counter-clockwise. Same legality gating as Y.
function applyL(fen: string): string {
  const fields = parseFen(fen)
  const n = fields.grid.length
  const rotated: string[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => fields.grid[j]?.[n - 1 - i] ?? '.'),
  )
  fields.grid = rotated
  return serializeFen(fields)
}

// View the position from the opponent's side: swap every piece's color AND mirror
// ranks (top<->bottom) together — recoloring in place without also flipping ranks
// would leave pawns pointing the wrong way. Combined, this is always legal
// regardless of pawns/castling (a pawn's forward direction and each side's
// castling squares both stay self-consistent under the combined operation).
function applyC(fen: string): string {
  const fields = parseFen(fen)
  fields.grid = [...fields.grid]
    .reverse()
    .map((row) => row.map((cell) => (cell === '.' ? cell : swapPieceCase(cell))))
  fields.activeColor = fields.activeColor === 'w' ? 'b' : 'w'
  fields.castling = swapCastlingRights(fields.castling)
  fields.enPassant = flipEnPassantRank(fields.enPassant)
  return serializeFen(fields)
}

export function hasCastlingRights(fen: string): boolean {
  return (fen.split(' ')[2] ?? '-') !== '-'
}

function hasPawns(fen: string): boolean {
  return /[Pp]/.test(fen.split(' ')[0] ?? '')
}

// Applies a transform code's letters in the fixed canonical order X, Y, R, L, C —
// regardless of the order they appear in `code` — so replaying a stored code
// always reproduces the exact same result it was recorded with.
// Re-checks legality against the (untransformed) `fen` before applying each
// letter — defense in depth against a stale/legacy code (e.g. one recorded
// before a legality rule changed) smuggling in an illegal transform: X needs no
// castling rights, Y/R/L additionally need no pawns.
export function applyTransformCode(fen: string, code: string): string {
  const filesLegal = !hasCastlingRights(fen)
  const rotationLegal = filesLegal && !hasPawns(fen)

  let result = fen
  if (code.includes('X') && filesLegal) result = applyX(result)
  if (code.includes('Y') && rotationLegal) result = applyY(result)
  if (code.includes('R') && rotationLegal) result = applyR(result)
  if (code.includes('L') && rotationLegal) result = applyL(result)
  if (code.includes('C')) result = applyC(result)
  return result
}

// Picks a random transform code for `fen`, flipping an independent 50/50 coin
// for each of X, Y, R, L, C (skipping any that aren't legal for this position).
// Legality is computed once from the original fen, since none of these ops
// change whether pawns or castling rights are present.
export function pickRandomTransformCode(fen: string): string {
  const filesLegal = !hasCastlingRights(fen)
  const rotationLegal = filesLegal && !hasPawns(fen)

  let code = ''
  if (filesLegal && Math.random() < 0.5) code += 'X'
  if (rotationLegal && Math.random() < 0.5) code += 'Y'
  if (rotationLegal && Math.random() < 0.5) code += 'R'
  if (rotationLegal && Math.random() < 0.5) code += 'L'
  if (Math.random() < 0.5) code += 'C'
  return code
}
