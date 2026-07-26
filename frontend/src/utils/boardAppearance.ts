// Board textures and piece sets, adopted from lichess (see public/board/ATTRIBUTION.md
// and public/piece/ATTRIBUTION.md). Every asset lives under a fixed path
// (/board/<theme>.<ext>, /piece/<set>/<code>.<ext>), which is what lets a single static
// stylesheet (assets/board-appearance.css) cover all of them: the stylesheet only reads
// CSS variables, and the apply* functions below point those at the selected set's files.
// No per-theme CSS is generated, and the browser only ever downloads the assets the
// variables currently point at — the rest are fetched in the background by
// preloadAssets.ts so they are cached before the user goes offline.

export type BoardThemeId =
  | 'brown'
  | 'wood4'
  | 'maple'
  | 'horsey'
  | 'blue'
  | 'blue2'
  | 'blue3'
  | 'green'
  | 'olive'
  | 'marble'
  | 'grey'
  | 'metal'
  | 'newspaper'
  | 'purple'
  | 'purple-diag'

export type PieceSetId =
  | 'cburnett'
  | 'merida'
  | 'kosal'
  | 'caliente'
  | 'rhosgfx'
  | 'maestro'
  | 'fresca'
  | 'cardinal'
  | 'gioco'
  | 'staunty'
  | 'monarchy'
  | 'dubrovny'
  | 'mpchess'
  | 'horsey'
  | 'anarcandy'

export const DEFAULT_BOARD_THEME: BoardThemeId = 'wood4'
export const DEFAULT_PIECE_SET: PieceSetId = 'maestro'

interface BoardTheme {
  // File extension of /board/<id>.<extension>
  extension: 'webp' | 'svg'
  // Coordinate label colours, picked for contrast against the square they sit on —
  // taken from lichess's own per-theme values (ui/lib/css/theme/board/_boards.scss,
  // where they are named the other way round: their "white" colour is the light-square
  // tone, which is exactly what reads well *on a dark square*).
  coordOnLightSquare: string
  coordOnDarkSquare: string
}

const BOARD_THEMES: Record<BoardThemeId, BoardTheme> = {
  brown: { extension: 'webp', coordOnLightSquare: '#946f51', coordOnDarkSquare: '#f0d9b5' },
  wood4: { extension: 'webp', coordOnLightSquare: '#7b5330', coordOnDarkSquare: '#caaf7d' },
  maple: { extension: 'webp', coordOnLightSquare: '#bc7944', coordOnDarkSquare: '#e8ceab' },
  horsey: { extension: 'webp', coordOnLightSquare: '#946f51', coordOnDarkSquare: '#f0d9b5' },
  blue: { extension: 'webp', coordOnLightSquare: '#788a94', coordOnDarkSquare: '#dee3e6' },
  blue2: { extension: 'webp', coordOnLightSquare: '#546f82', coordOnDarkSquare: '#97b2c7' },
  blue3: { extension: 'webp', coordOnLightSquare: '#315991', coordOnDarkSquare: '#d9e0e6' },
  green: { extension: 'webp', coordOnLightSquare: '#6d8753', coordOnDarkSquare: '#ffffdd' },
  olive: { extension: 'webp', coordOnLightSquare: '#6d6655', coordOnDarkSquare: '#b8b19f' },
  marble: { extension: 'webp', coordOnLightSquare: '#4f644e', coordOnDarkSquare: '#93ab91' },
  grey: { extension: 'webp', coordOnLightSquare: '#7d7d7d', coordOnDarkSquare: '#b8b8b8' },
  metal: { extension: 'webp', coordOnLightSquare: '#727272', coordOnDarkSquare: '#c9c9c9' },
  newspaper: { extension: 'svg', coordOnLightSquare: '#8d8d8d', coordOnDarkSquare: '#ffffff' },
  purple: { extension: 'webp', coordOnLightSquare: '#7d4a8d', coordOnDarkSquare: '#9f90b0' },
  'purple-diag': {
    extension: 'webp',
    coordOnLightSquare: '#957ab0',
    coordOnDarkSquare: '#e5daf0',
  },
}

// File extension of /piece/<id>/<code>.<extension> — every set is SVG except monarchy.
const PIECE_SETS: Record<PieceSetId, 'svg' | 'webp'> = {
  cburnett: 'svg',
  merida: 'svg',
  kosal: 'svg',
  caliente: 'svg',
  rhosgfx: 'svg',
  maestro: 'svg',
  fresca: 'svg',
  cardinal: 'svg',
  gioco: 'svg',
  staunty: 'svg',
  monarchy: 'webp',
  dubrovny: 'svg',
  mpchess: 'svg',
  horsey: 'svg',
  anarcandy: 'svg',
}

// Display order for the settings pickers: board themes grouped by hue family (wood,
// blue, green, grey, purple) so the picker reads as a colour spectrum; piece sets in
// lichess's own order.
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
