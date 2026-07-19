export type GameResult = 'win' | 'draw' | 'loss'
export enum PuzzleStatus {
  SOLVING = 'SOLVING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}
export type PlayerColor = 'white' | 'black'

export type TablebaseCategory =
  | 'win'
  | 'syzygy-win'
  | 'maybe-win'
  | 'cursed-win'
  | 'draw'
  | 'blessed-loss'
  | 'maybe-loss'
  | 'syzygy-loss'
  | 'loss'
  | 'unknown'

export interface TablebaseMove {
  uci: string
  san: string
  zeroing: boolean
  conversion: boolean
  checkmate: boolean
  stalemate: boolean
  insufficient_material: boolean
  dtz: number | null
  precise_dtz: number | null
  dtm: number | null
  dtw: number | null
  dtc: number | null
  category: TablebaseCategory
}

export interface TablebaseResult {
  category: TablebaseCategory
  moves: TablebaseMove[]
}

export interface EloHistoryEntry {
  timestamp: string
  exerciseDifficulty: number
  change: number
  newElo: number
  transformCode?: string
  exerciseId?: string
  solved?: boolean
}

// Hard filter applied to the exercise pool before category selection:
// - 'around': userElo -200 to userElo +200
// - 'aroundAndAbove': userElo -200 to +Infinity
// - 'aroundAndBelow': -Infinity to userElo +200
// - 'all': no elo filtering
export type DifficultyPreference = 'around' | 'aroundAndAbove' | 'aroundAndBelow' | 'all'

export type ThemeMode = 'dark' | 'light' | 'system'

export type Language = 'en' | 'de'

export interface UserProfile {
  username: string
  endgameElo: number
  puzzlesSolved: number
  puzzlesFailed: number
  eloHistory: EloHistoryEntry[]
  difficultyPreference: DifficultyPreference
  analysisEnginePaused: boolean
  tablebaseMovesExpanded: boolean
  themeMode: ThemeMode
  language: Language
  lichessUsername: string | null
  engineThreads: number
}

export interface EngineLine {
  moves: string[]
  scoreCP: number | null
  scoreMate: number | null
  depth: number
  multipvIndex: number
}

// What determined a line's dtd — the seed source (tablebase/engine) or the line-probe
// doneness check that ended up smallest. Debug logging only.
export type DtdReason =
  | 'tablebase dtm'
  | 'engine mate'
  | 'tablebase ordering'
  | `LineProbe ${string}`

export interface EngineLineWithDTD extends EngineLine {
  // Distance to done: half-moves from the current position until the human player would
  // consider the position solved (checkmate, or earlier simplification into a trivially
  // won/drawn position). null when unknown.
  dtd: number | null
  dtdReason: DtdReason | null
}

export interface AnalysisSettings {
  thinkingTimeMs: number
  numLines: number
  showBestArrow: boolean
  showTablebaseArrow: boolean
}
