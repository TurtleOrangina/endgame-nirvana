import type { Key } from '@lichess-org/chessground/types'
import type { BoardSound } from '@/composables/useBoardAudio'
import type { PuzzleStatus } from '@/types'

// One entry of ChessBoard's move history — see ChessBoard.vue, which aliases this as
// its internal HistoryEntry type so a snapshot is a plain serializable copy of it.
export interface BoardHistoryEntry {
  fen: string
  lastMove?: [Key, Key]
  movedBy: 'player' | 'engine' | null
  uciMove?: string
  movesSinceZero: number
  sound: BoardSound
  isOutsideGoal?: boolean
}

export interface BoardSnapshot {
  entries: BoardHistoryEntry[]
  index: number
  isGameOver: boolean
  gameOverEntryBeforeAnalysis: { index: number; fen: string } | null
}

// Everything needed to bring the training page back "as you left it" after a full page
// load: which puzzle (and in which random orientation), the rated/retry status, whether
// analysis mode was open, and the complete board history.
export interface TrainingSnapshot {
  exerciseId: string
  transformCode: string
  puzzleStatus: PuzzleStatus
  isAnalysisMode: boolean
  board: BoardSnapshot
}

// sessionStorage on purpose: the snapshot must survive same-tab navigations away and
// back (most importantly the Lichess OAuth link flow round-tripping through lichess.org)
// but should die with the tab, and must not leak between tabs.
const STORAGE_KEY = 'trainingSessionState'

export function saveTrainingSnapshot(snapshot: TrainingSnapshot): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Storage full or unavailable — restoring is best-effort only.
  }
}

export function clearTrainingSnapshot(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage unavailable — nothing to clear.
  }
}

// One-shot read: consuming the snapshot immediately means a restore that crashes can't
// wedge the app into re-restoring the same broken state on every subsequent load.
export function takeTrainingSnapshot(): TrainingSnapshot | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    sessionStorage.removeItem(STORAGE_KEY)
    const snapshot = JSON.parse(raw) as TrainingSnapshot
    if (
      typeof snapshot.exerciseId !== 'string' ||
      typeof snapshot.transformCode !== 'string' ||
      !Array.isArray(snapshot.board?.entries) ||
      snapshot.board.entries.length === 0
    ) {
      return null
    }
    return snapshot
  } catch {
    return null
  }
}
