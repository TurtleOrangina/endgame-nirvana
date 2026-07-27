// Board textures and piece sets, adopted from lichess (see public/board/ATTRIBUTION.md
// and public/piece/ATTRIBUTION.md). Every asset lives under a fixed path
// (/board/<theme>.<ext>, /piece/<set>/<code>.<ext>), which is what lets a single static
// stylesheet (assets/board-appearance.css) cover all of them: the stylesheet only reads
// CSS variables, and the apply* functions below point those at the selected set's files.
// No per-theme CSS is generated, and the browser only ever downloads the assets the
// variables currently point at — the rest are fetched in the background by
// preloadAssets.ts so they are cached before the user goes offline.

export type BoardThemeId =
  | 'wood4'
  | 'blue3'
  | 'green'
  | 'metal'
  | 'purple-diag'
  | 'newspaper'
  | 'maple'
  | 'blue'
  | 'olive'
  | 'marble'
  | 'grey'
  | 'purple'
  | 'blue2'
  | 'brown'

export type PieceSetId =
  | 'maestro'
  | 'staunty'
  | 'cburnett'
  | 'cardinal'
  | 'merida'
  | 'monarchy'
  | 'fresca'
  | 'gioco'
  | 'dubrovny'
  | 'kosal'
  | 'mpchess'
  | 'caliente'

export const DEFAULT_BOARD_THEME: BoardThemeId = 'wood4'
export const DEFAULT_PIECE_SET: PieceSetId = 'maestro'

interface BoardTheme {
  // File extension of /board/<id>.<extension>
  extension: 'webp' | 'svg'
  // Only where lichess's own id makes a poor label ('wood4', three unqualified blues);
  // everything else is derived from the id by appearanceDisplayName below.
  displayName?: string
  // Coordinate label colours, picked for contrast against the square they sit on —
  // taken from lichess's own per-theme values (ui/lib/css/theme/board/_boards.scss,
  // where they are named the other way round: their "white" colour is the light-square
  // tone, which is exactly what reads well *on a dark square*).
  coordOnLightSquare: string
  coordOnDarkSquare: string
}

const BOARD_THEMES: Record<BoardThemeId, BoardTheme> = {
  wood4: {
    extension: 'webp',
    displayName: 'Wood',
    coordOnLightSquare: '#7b5330',
    coordOnDarkSquare: '#caaf7d',
  },
  blue3: {
    extension: 'webp',
    displayName: 'Strong Blue',
    coordOnLightSquare: '#315991',
    coordOnDarkSquare: '#d9e0e6',
  },
  green: { extension: 'webp', coordOnLightSquare: '#6d8753', coordOnDarkSquare: '#ffffdd' },
  metal: { extension: 'webp', coordOnLightSquare: '#727272', coordOnDarkSquare: '#c9c9c9' },
  'purple-diag': {
    extension: 'webp',
    displayName: 'Light Purple',
    coordOnLightSquare: '#957ab0',
    coordOnDarkSquare: '#e5daf0',
  },
  newspaper: { extension: 'svg', coordOnLightSquare: '#8d8d8d', coordOnDarkSquare: '#ffffff' },
  maple: { extension: 'webp', coordOnLightSquare: '#bc7944', coordOnDarkSquare: '#e8ceab' },
  blue: {
    extension: 'webp',
    displayName: 'Light Blue',
    coordOnLightSquare: '#788a94',
    coordOnDarkSquare: '#dee3e6',
  },
  olive: { extension: 'webp', coordOnLightSquare: '#6d6655', coordOnDarkSquare: '#b8b19f' },
  marble: { extension: 'webp', coordOnLightSquare: '#4f644e', coordOnDarkSquare: '#93ab91' },
  grey: { extension: 'webp', coordOnLightSquare: '#7d7d7d', coordOnDarkSquare: '#b8b8b8' },
  purple: { extension: 'webp', coordOnLightSquare: '#7d4a8d', coordOnDarkSquare: '#9f90b0' },
  blue2: {
    extension: 'webp',
    displayName: 'Muted Blue',
    coordOnLightSquare: '#546f82',
    coordOnDarkSquare: '#97b2c7',
  },
  brown: { extension: 'webp', coordOnLightSquare: '#946f51', coordOnDarkSquare: '#f0d9b5' },
}

// File extension of /piece/<id>/<code>.<extension> — every set is SVG except monarchy.
const PIECE_SETS: Record<PieceSetId, 'svg' | 'webp'> = {
  maestro: 'svg',
  staunty: 'svg',
  cburnett: 'svg',
  cardinal: 'svg',
  merida: 'svg',
  monarchy: 'webp',
  fresca: 'svg',
  gioco: 'svg',
  dubrovny: 'svg',
  kosal: 'svg',
  mpchess: 'svg',
  caliente: 'svg',
}

// Display order for the pickers, best first — a hand-picked subset and ordering of
// lichess's sets, not their catalogue order. Removing an id is safe: a profile that
// still names one (or a future build's) falls back to the default via the guards below.
export const BOARD_THEME_IDS = Object.keys(BOARD_THEMES) as BoardThemeId[]
export const PIECE_SET_IDS = Object.keys(PIECE_SETS) as PieceSetId[]

// Chessground names pieces by type + colour ('piece.queen.black'); the asset files use
// lichess's two-letter codes. Keeping the mapping here means the stylesheet needs only
// one generic rule per piece, and both the CSS variables and the preloader derive their
// URLs from the same list.
export const PIECE_CODES = [
  'wP',
  'wN',
  'wB',
  'wR',
  'wQ',
  'wK',
  'bP',
  'bN',
  'bB',
  'bR',
  'bQ',
  'bK',
] as const

export type PieceCode = (typeof PIECE_CODES)[number]

// The ids come from a persisted (and cloud-synced) profile, which an older or newer
// build may have written — an unknown one falls back to the default instead of leaving
// the board unstyled.
export function isBoardThemeId(id: string | undefined): id is BoardThemeId {
  return id !== undefined && id in BOARD_THEMES
}

export function isPieceSetId(id: string | undefined): id is PieceSetId {
  return id !== undefined && id in PIECE_SETS
}

export function boardThemeOrDefault(id: string | undefined): BoardThemeId {
  return isBoardThemeId(id) ? id : DEFAULT_BOARD_THEME
}

export function pieceSetOrDefault(id: string | undefined): PieceSetId {
  return isPieceSetId(id) ? id : DEFAULT_PIECE_SET
}

// Piece sets keep the names their authors gave them (they are proper names, like a
// username), and so do most boards, so this deliberately doesn't go through t(): the
// only cosmetic step is formatting the id ('mpchess' → 'Mpchess'). Boards whose lichess
// id is a poor label carry an explicit displayName instead.
export function appearanceDisplayName(id: BoardThemeId | PieceSetId): string {
  if (isBoardThemeId(id)) {
    const { displayName } = BOARD_THEMES[id]
    if (displayName) return displayName
  }
  const spaced = id.replaceAll('-', ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function boardImageUrl(id: BoardThemeId): string {
  return `/board/${id}.${BOARD_THEMES[id].extension}`
}

export function pieceImageUrl(id: PieceSetId, code: PieceCode): string {
  return `/piece/${id}/${code}.${PIECE_SETS[id]}`
}

export function pieceImageUrls(id: PieceSetId): string[] {
  return PIECE_CODES.map((code) => pieceImageUrl(id, code))
}

export function applyBoardTheme(id: BoardThemeId): void {
  const theme = BOARD_THEMES[id]
  const style = document.documentElement.style
  style.setProperty('--board-image', `url('${boardImageUrl(id)}')`)
  style.setProperty('--coord-on-light-square', theme.coordOnLightSquare)
  style.setProperty('--coord-on-dark-square', theme.coordOnDarkSquare)
}

export function applyPieceSet(id: PieceSetId): void {
  const style = document.documentElement.style
  for (const code of PIECE_CODES) {
    style.setProperty(`--piece-${code}`, `url('${pieceImageUrl(id, code)}')`)
  }
}
