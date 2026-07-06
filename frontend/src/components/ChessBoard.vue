<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { DrawShape } from '@lichess-org/chessground/draw'
import type { BrushColor, Key, MoveMetadata } from '@lichess-org/chessground/types'
import { Chess, type Move, type Square } from 'chess.js'
import { useStockfishEngine } from '@/composables/useStockfishEngine'
import { useBoardAudio, type BoardSound } from '@/composables/useBoardAudio'
import { useLichessTablebase } from '@/composables/useLichessTablebase'
import { useLichessAuth } from '@/composables/useLichessAuth'
import { useLocale } from '@/composables/useLocale'
import { isOutsidePuzzleGoal } from '@/utils/puzzleEvaluation'
import { useUserProfileStore } from '@/stores/userProfile'
import { useExercisesStore } from '@/stores/exercises'
import type {
  GameResult,
  PlayerColor,
  EngineEvaluation,
  EngineLine,
  TablebaseCategory,
  TablebaseResult,
  AnalysisSettings,
} from '@/types'

type PromotionPiece = 'q' | 'r' | 'n' | 'b'

interface HistoryEntry {
  fen: string
  lastMove?: [Key, Key]
  movedBy: 'player' | 'engine' | null
  uciMove?: string
  movesSinceZero: number
  sound: BoardSound
}

interface PendingPromotion {
  dest: Key
  color: PlayerColor
  resolve: (piece: PromotionPiece | null) => void
}

const PROMOTION_OPTIONS: {
  piece: PromotionPiece
  name: 'queen' | 'rook' | 'knight' | 'bishop'
}[] = [
  { piece: 'q', name: 'queen' },
  { piece: 'r', name: 'rook' },
  { piece: 'n', name: 'knight' },
  { piece: 'b', name: 'bishop' },
]

const TEMPERATURE_RATED = 0.35 // in rated trys the engine defends more accurately
const TEMPERATURE_RETRY = 0.6 // on retrys more variance is accepted, to see more variations

// A premove signals the player is in a hurry and not weighing this position carefully, so
// the engine's reply to the one move following it thinks for much less time than usual.
const PREMOVE_ENGINE_THINKING_TIME_MS = 50

// User-drawn arrows/marked squares are coloured by the modifier key held when the
// right-click drag starts: none = blue, Alt = red, Ctrl = green, Shift = yellow.
// Chessground's built-in modifier-to-brush mapping can't tell Shift and Ctrl apart (both
// collapse to the same slot), so we pick the brush ourselves — see
// attachUserShapeColorOverride — instead of relying on it.
const USER_SHAPE_BRUSHES: Record<BrushColor, { key: string; color: string }> = {
  blue: { key: 'ub', color: '#3b82f6' },
  red: { key: 'ur', color: '#dc2626' },
  green: { key: 'ug', color: '#22c55e' },
  yellow: { key: 'uy', color: '#e6b800' },
}
const USER_ARROW_MARKERS = new Set(
  Object.values(USER_SHAPE_BRUSHES).map((brush) => `url(#arrowhead-${brush.key})`),
)
const SQUARE_TINT_ALPHA = 0.5
// How far, in board-square units, to pull each arrow end away from its square centre so the
// arrow leaves a bit of breathing room instead of starting/ending dead-centre.
const ARROW_TAIL_INSET = 0.15 // origin end (Chessground starts it exactly at the centre)
const ARROW_HEAD_INSET = 0.15 // destination end (on top of Chessground's small built-in margin)

const props = defineProps<{
  fen: string
  analysisSettings: AnalysisSettings
  isRatedAttempt: boolean
}>()

const emit = defineEmits<{
  'game-over': [result: GameResult]
  'goal-evaluated': [isOutsideGoal: boolean]
  'analysis-update': [lines: EngineLine[], tablebaseResult: TablebaseResult | null, fen: string]
}>()

const boardEl = ref<HTMLElement | null>(null)
let cg: Api | null = null
let arrowInsetObserver: MutationObserver | null = null
let chess: Chess | null = null
let playerColor: PlayerColor = 'white'
let moveGeneration = 0
let engineMovePending = false

const engine = useStockfishEngine()
const boardAudio = useBoardAudio()
const { t } = useLocale()
const tablebase = useLichessTablebase()
const lichessAuth = useLichessAuth()

const historyEntries = ref<HistoryEntry[]>([])
const historyIndex = ref(0)
const isGameOver = ref(false)
const pendingPromotion = ref<PendingPromotion | null>(null)
const isAnalysisMode = ref(false)
const analysisPaused = ref(false)
// True from the moment the player's move is committed until control returns to them —
// either via the engine's reply or restorePlayerMovable(). Lets "play best move" know
// whether it's actually the player's turn outside analysis mode.
const isWaitingForEngineReply = ref(false)

const hasMoves = computed(() => historyEntries.value.length > 1)
const currentMovesSinceZero = computed(
  () => historyEntries.value[historyIndex.value]?.movesSinceZero ?? 0,
)
const displayMovesSinceZero = computed(() => Math.floor(currentMovesSinceZero.value / 2))
const pinnedTooltip = ref<'zero' | null>(null)
let pinnedTooltipTimeout: ReturnType<typeof setTimeout> | undefined
const PINNED_TOOLTIP_AUTO_CLOSE_MS = 5000

function toggleTooltip(which: 'zero'): void {
  clearTimeout(pinnedTooltipTimeout)
  if (pinnedTooltip.value === which) {
    pinnedTooltip.value = null
    return
  }
  pinnedTooltip.value = which
  pinnedTooltipTimeout = setTimeout(() => {
    pinnedTooltip.value = null
  }, PINNED_TOOLTIP_AUTO_CLOSE_MS)
}

function computeMovesSinceZero(move: Move): number {
  const prev = historyEntries.value[historyIndex.value]?.movesSinceZero ?? 0
  return move.piece === 'p' || !!move.captured ? 0 : prev + 1
}

const promotionPickerStyle = computed(() => {
  if (!pendingPromotion.value) return {}
  const fileIndex = (pendingPromotion.value.dest as string).charCodeAt(0) - 97
  const col = playerColor === 'white' ? fileIndex : 7 - fileIndex
  const atTop = playerColor === pendingPromotion.value.color
  return {
    left: `${col * 12.5}%`,
    top: atTop ? '0' : 'auto',
    bottom: atTop ? 'auto' : '0',
  }
})

function isViewingHistory(): boolean {
  return historyIndex.value < historyEntries.value.length - 1
}

function classifyMoveSound(move: Move, chessAfterMove: Chess): BoardSound {
  if (chessAfterMove.isCheckmate()) return 'checkmate'
  if (chessAfterMove.inCheck()) return 'check'
  if (move.isPromotion()) return 'promote'
  if (move.isKingsideCastle() || move.isQueensideCastle()) return 'castle'
  if (move.isCapture() || move.isEnPassant()) return 'capture'
  return 'move'
}

function toColor(turn: 'w' | 'b'): PlayerColor {
  return turn === 'w' ? 'white' : 'black'
}

function boardFen(fen: string): string {
  return fen.split(' ')[0] ?? fen
}

function buildDests(ch: Chess): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>()
  for (const move of ch.moves({ verbose: true })) {
    const from = move.from as Key
    const existing = dests.get(from)
    if (existing) {
      existing.push(move.to as Key)
    } else {
      dests.set(from, [move.to as Key])
    }
  }
  return dests
}

function isPromotionMove(ch: Chess, from: string, to: string): boolean {
  return (
    ch
      .moves({ verbose: true })
      .find((m: Move) => (m.from as string) === from && (m.to as string) === to)
      ?.isPromotion() ?? false
  )
}

function parseEngineMove(bestmove: string): { from: string; to: string; promotion?: string } {
  return {
    from: bestmove.slice(0, 2),
    to: bestmove.slice(2, 4),
    promotion: bestmove.length > 4 ? bestmove[4] : undefined,
  }
}

function hexToRgba(hex: string, alpha: number): string {
  const value = hex.replace('#', '')
  const r = Number.parseInt(value.slice(0, 2), 16)
  const g = Number.parseInt(value.slice(2, 4), 16)
  const b = Number.parseInt(value.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function squareTintColor(brush: string | undefined): string {
  const color =
    brush && brush in USER_SHAPE_BRUSHES
      ? USER_SHAPE_BRUSHES[brush as BrushColor].color
      : USER_SHAPE_BRUSHES.blue.color
  return hexToRgba(color, SQUARE_TINT_ALPHA)
}

// Chessground restricts drawable shapes to one of four fixed brush slots
// ('blue'/'red'/'green'/'yellow'). Its own eventBrush() picks a slot from the modifier
// keys held at drag-start, but conflates Shift and Ctrl into the same slot — so we
// override the slot it picked right after mousedown, using our own mapping instead.
function userArrowColorForEvent(e: MouseEvent): BrushColor {
  if (e.altKey) return 'red'
  if (e.ctrlKey) return 'green'
  if (e.shiftKey) return 'yellow'
  return 'blue'
}

function attachUserShapeColorOverride(boardCg: HTMLElement): void {
  boardCg.addEventListener(
    'mousedown',
    (e) => {
      const current = cg?.state.drawable.current
      if (current) current.brush = userArrowColorForEvent(e)
    },
    { passive: false },
  )
}

function applySquareTints(shapes: DrawShape[]): void {
  if (!boardEl.value) return
  const board = boardEl.value.querySelector('cg-board')
  if (!board) return
  board.querySelectorAll('.sq-tint').forEach((el) => el.remove())
  for (const s of shapes) {
    if (s.dest) continue
    const col = s.orig.charCodeAt(0) - 97
    const row = s.orig.charCodeAt(1) - 49
    const div = document.createElement('div')
    div.className = 'sq-tint'
    div.style.background = squareTintColor(s.brush)
    if (playerColor === 'white') {
      div.style.left = `${col * 12.5}%`
      div.style.bottom = `${row * 12.5}%`
    } else {
      div.style.left = `${(7 - col) * 12.5}%`
      div.style.bottom = `${(7 - row) * 12.5}%`
    }
    board.prepend(div)
  }
}

function onDrawableChange(shapes: DrawShape[]): void {
  applySquareTints(shapes)
}

// Chessground silently resets its own drawable.shapes (without firing onChange) whenever
// a fen is set, which is how user-drawn arrows disappear on every move. Our square-tint
// overlays live outside Chessground's own rendering, so they need the same reset applied
// by hand whenever a move sets a new fen.
function setCgState(config: Parameters<Api['set']>[0]): void {
  if (!cg) return
  cg.set(config)
  if (config.fen !== undefined) applySquareTints([])
}

// Chessground has no config for arrow length, so we nudge the endpoints of each user-drawn
// arrow inward after it is added to the SVG, leaving space around both square centres.
function insetUserArrow(line: SVGLineElement): void {
  const markerEnd = line.getAttribute('marker-end')
  if (!markerEnd || !USER_ARROW_MARKERS.has(markerEnd)) return
  const x1 = Number(line.getAttribute('x1'))
  const y1 = Number(line.getAttribute('y1'))
  const x2 = Number(line.getAttribute('x2'))
  const y2 = Number(line.getAttribute('y2'))
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.hypot(dx, dy)
  if (length === 0) return
  // Clamp so arrows between adjacent squares stay visible and never invert.
  const maxInset = length - 0.2
  const tail = Math.min(ARROW_TAIL_INSET, maxInset * 0.6)
  const head = Math.min(ARROW_HEAD_INSET, maxInset * 0.4)
  const unitX = dx / length
  const unitY = dy / length
  line.setAttribute('x1', String(x1 + unitX * tail))
  line.setAttribute('y1', String(y1 + unitY * tail))
  line.setAttribute('x2', String(x2 - unitX * head))
  line.setAttribute('y2', String(y2 - unitY * head))
}

function observeUserArrows(): void {
  arrowInsetObserver?.disconnect()
  const shapesGroup = boardEl.value?.querySelector('.cg-shapes g')
  if (!shapesGroup) return
  arrowInsetObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue
        const line = node.querySelector('line')
        if (line instanceof SVGLineElement) insetUserArrow(line)
      }
    }
  })
  arrowInsetObserver.observe(shapesGroup, { childList: true })
}

function countPieces(fen: string): number {
  return (fen.split(' ')[0] ?? '').split('').filter((c) => /[a-zA-Z]/.test(c)).length
}

function piecesByColor(fen: string): { white: string[]; black: string[] } {
  const board = (fen.split(' ')[0] ?? '').replace(/[0-9/]/g, '')
  const white: string[] = []
  const black: string[] = []
  for (const piece of board) {
    if (piece === piece.toUpperCase()) white.push(piece.toLowerCase())
    else black.push(piece)
  }
  return { white, black }
}

// True when the opponent is down to a bare king and we hold at least one queen or
// rook (any other material on either side, e.g. extra pawns/minors, doesn't matter).
function isBareKingVsMajorPiece(fen: string): boolean {
  const { white, black } = piecesByColor(fen)
  const playerPieces = playerColor === 'white' ? white : black
  const opponentPieces = playerColor === 'white' ? black : white
  const opponentIsBareKing = opponentPieces.length === 1 && opponentPieces[0] === 'k'
  const playerHasMajorPiece = playerPieces.includes('q') || playerPieces.includes('r')
  return opponentIsBareKing && playerHasMajorPiece
}

// Auto-solves as a win once the position has been reduced to a trivial mating
// material advantage (bare king vs. at least one queen or rook), but only if the
// player is genuinely winning right now and this material edge wasn't already
// present when the puzzle started (otherwise every move of an already-KQK/KRK
// puzzle would instantly auto-solve).
function shouldAutoSolve(
  fen: string,
  scoreCP: number | null,
  scoreMate: number | null,
  tablebaseCategory: TablebaseCategory | null,
): boolean {
  const userElo = useUserProfileStore().profile?.endgameElo ?? 0
  if (userElo <= 1000) return false
  if (isOutsidePuzzleGoal('win', scoreCP, scoreMate, tablebaseCategory)) return false
  const initialFen = historyEntries.value[0]?.fen
  if (initialFen && isBareKingVsMajorPiece(initialFen)) return false
  return isBareKingVsMajorPiece(fen)
}

function shouldQueryTablebase(fen: string): boolean {
  return lichessAuth.isLinked.value && countPieces(fen) <= 8
}

const bestEngineMoveUci = ref<string | null>(null)
const bestTablebaseMoveUci = ref<string | null>(null)
const hoveredMoveUci = ref<string | null>(null)

function uciToShape(uci: string, brush: string): DrawShape | null {
  if (uci.length < 4) return null
  return { orig: uci.slice(0, 2) as Key, dest: uci.slice(2, 4) as Key, brush }
}

// Best-engine and best-tablebase arrows are hidden while their move is the
// hovered move so the green hover arrow isn't drawn on top of them.
function updateAutoShapes(): void {
  if (!cg) return
  const { showBestArrow, showTablebaseArrow } = props.analysisSettings
  const hovered = hoveredMoveUci.value
  const shapes: DrawShape[] = []
  if (showBestArrow && bestEngineMoveUci.value && bestEngineMoveUci.value !== hovered) {
    const shape = uciToShape(bestEngineMoveUci.value, 'engineBest')
    if (shape) shapes.push(shape)
  }
  if (showTablebaseArrow && bestTablebaseMoveUci.value && bestTablebaseMoveUci.value !== hovered) {
    const shape = uciToShape(bestTablebaseMoveUci.value, 'tablebaseBest')
    if (shape) shapes.push(shape)
  }
  if (hovered) {
    const shape = uciToShape(hovered, 'moveHover')
    if (shape) shapes.push(shape)
  }
  cg.setAutoShapes(shapes)
}

function resetAnalysisArrows(): void {
  bestEngineMoveUci.value = null
  bestTablebaseMoveUci.value = null
  hoveredMoveUci.value = null
  updateAutoShapes()
}

function determineResult(movedBy: 'player' | 'engine'): GameResult | null {
  if (!chess || !chess.isGameOver()) return null
  if (chess.isDraw()) return 'draw'
  return movedBy === 'player' ? 'win' : 'loss'
}

type KingBadge = 'win' | 'loss' | 'draw'

interface GameEndInfo {
  reasonLines: [string] | [string, string]
  whiteKingSquare: Square
  blackKingSquare: Square
  whiteBadge: KingBadge
  blackBadge: KingBadge
}

function findKingSquare(ch: Chess, color: 'w' | 'b'): Square | null {
  for (const row of ch.board()) {
    for (const piece of row) {
      if (piece?.type === 'k' && piece.color === color) return piece.square
    }
  }
  return null
}

// The board, side-to-move, castling rights, and en-passant target square together define
// a "position" for repetition purposes — the halfmove clock and fullmove number don't count.
function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

// classifyGameEnd is called with a fresh `new Chess(fen)` that has no move history of its
// own, so ch.isThreefoldRepetition() (which relies on chess.js's internal history) can never
// detect a repetition there — only the long-lived `chess` instance that accumulated moves via
// chess.move() can. We instead recompute repetition ourselves from our own recorded history
// so the display stays in sync with however the game actually ended. Only positions up to and
// including the one currently displayed count — otherwise stepping back through history to an
// earlier occurrence of the position would already show it as repeated, based on repeats that
// hadn't happened yet at that point in the game.
function isThreefoldRepetitionByHistory(fen: string): boolean {
  const key = positionKey(fen)
  const upToCurrent = historyEntries.value.slice(0, historyIndex.value + 1)
  return upToCurrent.filter((entry) => positionKey(entry.fen) === key).length >= 3
}

// Ordered by specificity: isDraw() alone can't distinguish which of these caused it.
function classifyGameEnd(
  ch: Chess,
  isThreefoldByHistory: boolean,
): { winner: 'w' | 'b' | null; reasonLines: [string] | [string, string] } | null {
  if (ch.isCheckmate())
    return { winner: ch.turn() === 'w' ? 'b' : 'w', reasonLines: [t((s) => s.board.checkmate)] }
  if (ch.isStalemate())
    return { winner: null, reasonLines: [t((s) => s.board.draw), t((s) => s.board.stalemate)] }
  if (isThreefoldByHistory || ch.isThreefoldRepetition())
    return {
      winner: null,
      reasonLines: [t((s) => s.board.draw), t((s) => s.board.threefoldRepetition)],
    }
  if (ch.isDrawByFiftyMoves())
    return { winner: null, reasonLines: [t((s) => s.board.draw), t((s) => s.board.fiftyMoveRule)] }
  if (ch.isInsufficientMaterial())
    return {
      winner: null,
      reasonLines: [t((s) => s.board.draw), t((s) => s.board.insufficientMaterial)],
    }
  if (ch.isDraw()) return { winner: null, reasonLines: [t((s) => s.board.draw)] }
  return null
}

const gameEndInfo = ref<GameEndInfo | null>(null)
// Bumped every time a game-end position is (re-)reached, so the reason banner replays
// its animation even when the underlying reason text hasn't changed (e.g. stepping away
// from and back to the same checkmate with the arrow keys).
const gameEndAnimationKey = ref(0)

// Re-evaluated against whatever position is currently on display — including in analysis
// mode and while stepping through history — rather than tied only to the live game state.
function updateGameEndDisplay(fen: string | undefined): void {
  if (!fen) {
    gameEndInfo.value = null
    return
  }
  const ch = new Chess(fen)
  const classification = classifyGameEnd(ch, isThreefoldRepetitionByHistory(fen))
  const whiteKingSquare = classification ? findKingSquare(ch, 'w') : null
  const blackKingSquare = classification ? findKingSquare(ch, 'b') : null
  if (!classification || !whiteKingSquare || !blackKingSquare) {
    gameEndInfo.value = null
    return
  }

  gameEndInfo.value = {
    reasonLines: classification.reasonLines,
    whiteKingSquare,
    blackKingSquare,
    whiteBadge:
      classification.winner === null ? 'draw' : classification.winner === 'w' ? 'win' : 'loss',
    blackBadge:
      classification.winner === null ? 'draw' : classification.winner === 'b' ? 'win' : 'loss',
  }
  gameEndAnimationKey.value++
}

function squareCoordStyle(square: Square): { left: string; bottom: string } {
  const col = square.charCodeAt(0) - 97
  const row = square.charCodeAt(1) - 49
  return playerColor === 'white'
    ? { left: `${col * 12.5}%`, bottom: `${row * 12.5}%` }
    : { left: `${(7 - col) * 12.5}%`, bottom: `${(7 - row) * 12.5}%` }
}

const whiteKingBadgeStyle = computed(() =>
  gameEndInfo.value ? squareCoordStyle(gameEndInfo.value.whiteKingSquare) : {},
)
const blackKingBadgeStyle = computed(() =>
  gameEndInfo.value ? squareCoordStyle(gameEndInfo.value.blackKingSquare) : {},
)

const KING_BADGE_LABELS: Record<KingBadge, string> = { win: '1', loss: '0', draw: '½' }

function pushHistory(entry: HistoryEntry): void {
  historyEntries.value.push(entry)
  historyIndex.value = historyEntries.value.length - 1
}

function restorePlayerMovable(): void {
  if (!chess || !cg) return
  isWaitingForEngineReply.value = false
  cg.set({
    turnColor: playerColor,
    movable: { color: playerColor, free: false, dests: buildDests(chess) },
  })
}

function endGame(result: GameResult): void {
  if (!cg || !chess) return
  isWaitingForEngineReply.value = false
  isGameOver.value = true
  cg.set({ movable: { color: undefined } })
  updateGameEndDisplay(chess.fen())
  emit('game-over', result)
}

// Outside analysis mode, browsing history is normally read-only — but while retrying
// (not a rated attempt), the player is allowed to play a different move than they
// originally did, provided it's genuinely their move at that position (never the
// computer's), branching the history from there.
function canResumeFromHistory(): boolean {
  return !!chess && !props.isRatedAttempt && toColor(chess.turn()) === playerColor
}

function showHistoryPosition(soundFallback?: HistoryEntry): void {
  if (!cg || !chess) return
  const entry = historyEntries.value[historyIndex.value]
  if (!entry) return

  const soundSource = entry.lastMove ? entry : soundFallback
  if (soundSource?.lastMove) {
    boardAudio.play(soundSource.sound)
  }

  if (isAnalysisMode.value) {
    // Keep chess in sync with whatever position is displayed so moves work from anywhere
    chess = new Chess(entry.fen)
    setCgState({
      fen: boardFen(entry.fen),
      lastMove: entry.lastMove,
      turnColor: toColor(chess.turn()),
      movable: { color: 'both', free: false, dests: buildDests(chess) },
    })
  } else {
    const atLatest = historyIndex.value === historyEntries.value.length - 1
    if (atLatest) {
      // Stepping back to a resumable position reassigns `chess` to that historical
      // position, and stepping forward through a non-resumable entry leaves it there —
      // so on returning to the latest entry, `chess` may be stale and must be rebuilt.
      if (chess.fen() !== entry.fen) chess = rebuildChessAtLatestEntry()
      setCgState({
        fen: boardFen(entry.fen),
        lastMove: entry.lastMove,
        turnColor: toColor(chess.turn()),
        movable: isGameOver.value
          ? { color: undefined }
          : { color: playerColor, free: false, dests: buildDests(chess) },
      })
    } else {
      const historyChess = new Chess(entry.fen)
      const canResumeHere = !props.isRatedAttempt && toColor(historyChess.turn()) === playerColor
      if (canResumeHere) {
        chess = historyChess
        setCgState({
          fen: boardFen(entry.fen),
          lastMove: entry.lastMove,
          turnColor: playerColor,
          movable: { color: playerColor, free: false, dests: buildDests(chess) },
        })
      } else {
        setCgState({
          fen: boardFen(entry.fen),
          lastMove: entry.lastMove,
          movable: { color: undefined },
        })
      }
    }
  }
  onPositionChanged()
}

// Replays the full recorded game instead of just loading the latest FEN, so chess.js's
// internal position history (needed for threefold-repetition detection) is preserved.
function rebuildChessAtLatestEntry(): Chess {
  const { fen, moves } = getPositionArgs(historyEntries.value.length - 1)
  const rebuilt = new Chess(fen)
  for (const uci of moves) {
    rebuilt.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci[4] as PromotionPiece | undefined,
    })
  }
  return rebuilt
}

function requestPromotion(dest: Key, color: PlayerColor): Promise<PromotionPiece | null> {
  return new Promise((resolve) => {
    pendingPromotion.value = { dest, color, resolve }
  })
}

function selectPromotion(piece: PromotionPiece): void {
  pendingPromotion.value?.resolve(piece)
  pendingPromotion.value = null
}

function cancelPendingPromotion(): void {
  pendingPromotion.value?.resolve(null)
  pendingPromotion.value = null
}

function setupBoard(fen: string): void {
  if (!boardEl.value) return

  cancelPendingPromotion()
  engine.stopAnalysis()
  moveGeneration++
  chess = new Chess(fen)
  playerColor = toColor(chess.turn())
  const color = playerColor
  isGameOver.value = false
  isAnalysisMode.value = false
  isFindingBestMove.value = false
  isWaitingForEngineReply.value = false
  gameEndInfo.value = null

  historyEntries.value = [
    { fen, lastMove: undefined, movedBy: null, movesSinceZero: 0, sound: 'move' },
  ]
  historyIndex.value = 0

  cg?.destroy()
  cg = Chessground(boardEl.value, {
    fen: boardFen(fen),
    orientation: color,
    turnColor: color,
    movable: {
      color,
      free: false,
      dests: buildDests(chess),
      showDests: true,
      events: { after: onAfterMove },
    },
    premovable: { enabled: true, showDests: true },
    animation: { enabled: true, duration: 150 },
    highlight: { lastMove: true, check: true },
    drawable: {
      enabled: true,
      visible: true,
      eraseOnMovablePieceClick: false,
      onChange: onDrawableChange,
      brushes: {
        blue: { ...USER_SHAPE_BRUSHES.blue, opacity: 1, lineWidth: 10 },
        red: { ...USER_SHAPE_BRUSHES.red, opacity: 1, lineWidth: 10 },
        green: { ...USER_SHAPE_BRUSHES.green, opacity: 1, lineWidth: 10 },
        yellow: { ...USER_SHAPE_BRUSHES.yellow, opacity: 1, lineWidth: 10 },
        engineBest: { key: 'eb', color: '#6b7280', opacity: 0.8, lineWidth: 10 },
        tablebaseBest: { key: 'tb', color: '#e6c200', opacity: 0.8, lineWidth: 10 },
        moveHover: { key: 'mh', color: '#22c55e', opacity: 0.8, lineWidth: 10 },
      },
    },
  })
  observeUserArrows()
  const boardCg = boardEl.value.querySelector<HTMLElement>('cg-board')
  if (boardCg) attachUserShapeColorOverride(boardCg)
}

function resetBoard(): void {
  cancelPendingPromotion()
  setupBoard(props.fen)
}

function takeBack(): void {
  if (!chess || !cg) return
  cancelPendingPromotion()

  const entries = historyEntries.value
  if (entries.length <= 1) return

  const last = entries[entries.length - 1]
  let targetLength = entries.length - 1
  if (last?.movedBy === 'engine' && targetLength > 1) {
    targetLength--
  }

  historyEntries.value = entries.slice(0, targetLength)
  historyIndex.value = targetLength - 1

  const targetEntry = historyEntries.value[historyIndex.value]
  if (!targetEntry) return

  moveGeneration++
  isGameOver.value = false
  isWaitingForEngineReply.value = false

  chess = new Chess(targetEntry.fen)
  playerColor = toColor(chess.turn())

  setCgState({
    fen: boardFen(targetEntry.fen),
    lastMove: targetEntry.lastMove,
    turnColor: playerColor,
    movable: { color: playerColor, free: false, dests: buildDests(chess) },
  })
  onPositionChanged()
}

function makeMove(uci: string): void {
  if (!chess || !cg) return
  if (isViewingHistory() && !isAnalysisMode.value) return
  const from = uci.slice(0, 2) as Key
  const to = uci.slice(2, 4) as Key
  const promotion = uci[4] as PromotionPiece | undefined
  try {
    const move = chess.move({ from: from as string, to: to as string, promotion })
    const sound = classifyMoveSound(move, chess)
    boardAudio.play(sound)
    if (isAnalysisMode.value && isViewingHistory()) {
      historyEntries.value = historyEntries.value.slice(0, historyIndex.value + 1)
    }
    pushHistory({
      fen: chess.fen(),
      lastMove: [from, to],
      movedBy: 'player',
      uciMove: uci,
      movesSinceZero: computeMovesSinceZero(move),
      sound,
    })
    setCgState({
      fen: boardFen(chess.fen()),
      lastMove: [from, to],
      turnColor: toColor(chess.turn()),
      movable: { color: 'both', free: false, dests: buildDests(chess) },
    })
    onPositionChanged()
  } catch {
    // invalid move
  }
}

function showMoveArrow(uci: string | null): void {
  hoveredMoveUci.value = uci
  updateAutoShapes()
}

function getPositionArgs(atIndex: number = historyIndex.value): { fen: string; moves: string[] } {
  const startFen = historyEntries.value[0]?.fen ?? ''
  const moves = historyEntries.value
    .slice(1, atIndex + 1)
    .map((e) => e.uciMove)
    .filter((m): m is string => !!m)
  return { fen: startFen, moves }
}

function onPositionChanged(): void {
  const entry = historyEntries.value[historyIndex.value]
  updateGameEndDisplay(entry?.fen)
  if (!isAnalysisMode.value) return
  if (!entry) return
  if (analysisPaused.value) {
    const pausedFen = entry.fen
    bestEngineMoveUci.value = null
    bestTablebaseMoveUci.value = null
    hoveredMoveUci.value = null
    updateAutoShapes()
    emit('analysis-update', [], null, pausedFen)
    if (shouldQueryTablebase(pausedFen)) {
      tablebase.query(pausedFen).then((tbResult) => {
        if (analysisPaused.value && historyEntries.value[historyIndex.value]?.fen === pausedFen) {
          bestTablebaseMoveUci.value = tbResult?.moves[0]?.uci ?? null
          updateAutoShapes()
          emit('analysis-update', [], tbResult, pausedFen)
        }
      })
    }
    return
  }
  moveGeneration++
  resetAnalysisArrows()
  emit('analysis-update', [], null, entry.fen)
  const { fen, moves } = getPositionArgs()
  runAnalysis(entry.fen, fen, moves)
}

function setAnalysisPaused(paused: boolean): void {
  analysisPaused.value = paused
  if (paused) {
    moveGeneration++
    engine.stopAnalysis()
  }
  onPositionChanged()
}

async function runAnalysis(currentFen: string, startFen: string, moves: string[]): Promise<void> {
  const gen = moveGeneration
  const { numLines, thinkingTimeMs } = props.analysisSettings

  let latestLines: EngineLine[] = []
  let latestTbResult: TablebaseResult | null = null

  function emitProgress(lines: EngineLine[], tbResult: TablebaseResult | null): void {
    if (moveGeneration !== gen) return
    bestEngineMoveUci.value = lines[0]?.moves[0] ?? null
    bestTablebaseMoveUci.value = tbResult?.moves[0]?.uci ?? null
    updateAutoShapes()
    emit('analysis-update', lines, tbResult, currentFen)
  }

  const tablebasePromise: Promise<TablebaseResult | null> = shouldQueryTablebase(currentFen)
    ? tablebase.query(currentFen).then((result) => {
        latestTbResult = result
        emitProgress(latestLines, result)
        return result
      })
    : Promise.resolve(null)

  const [engineResult, tbResult] = await Promise.allSettled([
    engine.getAnalysis(startFen, numLines, thinkingTimeMs, moves, (progressLines) => {
      latestLines = progressLines
      emitProgress(progressLines, latestTbResult)
    }),
    tablebasePromise,
  ])

  if (moveGeneration !== gen) return

  const lines = engineResult.status === 'fulfilled' ? engineResult.value : []
  const tbData = tbResult.status === 'fulfilled' ? tbResult.value : null
  emitProgress(lines, tbData)
}

async function awaitPromotionChoice(
  gen: number,
  orig: Key,
  dest: Key,
): Promise<PromotionPiece | null> {
  if (!chess || !cg) return null
  const promotingColor = toColor(chess.turn())
  const displayChess = new Chess(chess.fen())
  displayChess.remove(orig as Square)
  displayChess.remove(dest as Square)
  setCgState({
    fen: boardFen(displayChess.fen()),
    lastMove: undefined,
    movable: { color: undefined },
  })
  const chosen = await requestPromotion(dest, promotingColor)
  if (moveGeneration !== gen || !chess || !cg || chosen === null) return null
  return chosen
}

async function raceForBestMove(
  currentFen: string,
  isPremove: boolean,
): Promise<{
  bestmove: string | null
  evalResult: EngineEvaluation
  tbData: TablebaseResult | null
}> {
  let evalResult: EngineEvaluation = { bestMove: null, scoreCP: null, scoreMate: null }
  let tbData: TablebaseResult | null = null

  const { fen: startFen, moves } = getPositionArgs()
  const enginePromise = engine.getBestMove(
    startFen,
    moves,
    isPremove ? PREMOVE_ENGINE_THINKING_TIME_MS : undefined,
  )
  const tablebasePromise: Promise<TablebaseResult | null> = shouldQueryTablebase(currentFen)
    ? tablebase.query(currentFen)
    : Promise.resolve(null)

  // Resolves only when tablebase returns a concrete move — otherwise stays pending so engine wins
  const tbMovePromise = new Promise<string>((resolve) => {
    tablebasePromise
      .then((result) => {
        tbData = result
        const temperature = props.isRatedAttempt ? TEMPERATURE_RATED : TEMPERATURE_RETRY
        const move = result ? tablebase.selectBestMove(result, temperature, currentFen) : null
        if (move) resolve(move)
      })
      .catch(() => {
        // tablebase failed — engine will win the race
      })
  })

  const engineMovePromise = enginePromise
    .then((result) => {
      evalResult = result
      return result.bestMove
    })
    .catch((): string | null => null)

  // Safety net: if both engine and tablebase hang (e.g. engine crash, network failure),
  // resolve with null after a generous timeout so the board never freezes permanently.
  // The clock only starts once the engine is actually ready — it can otherwise still be
  // downloading its WASM binary, which legitimately takes far longer than 15s on a slow
  // connection and isn't itself a hang.
  const timeoutPromise = new Promise<null>((resolve) => {
    const startTimer = (): void => {
      setTimeout(() => resolve(null), 15_000)
    }
    if (engine.isReady.value) {
      startTimer()
    } else {
      const stopWatch = watch(engine.isReady, (ready) => {
        if (ready) {
          stopWatch()
          startTimer()
        }
      })
    }
  })

  const bestmove = await Promise.race([tbMovePromise, engineMovePromise, timeoutPromise])
  return { bestmove, evalResult, tbData }
}

function checkExerciseFailure(evalResult: EngineEvaluation, tbData: TablebaseResult | null): void {
  const exercise = useExercisesStore().currentExercise
  if (!exercise) return
  const isOutsideGoal = isOutsidePuzzleGoal(
    exercise.expectedResult,
    evalResult.scoreCP,
    evalResult.scoreMate,
    tbData?.category ?? null,
  )
  emit('goal-evaluated', isOutsideGoal)
}

async function applyEngineReply(bestmove: string): Promise<void> {
  if (!chess || !cg) return
  const { from: engFrom, to: engTo, promotion: engProm } = parseEngineMove(bestmove)
  let engineMove: Move
  try {
    engineMove = chess.move({ from: engFrom, to: engTo, promotion: engProm })
  } catch {
    // Engine returned an illegal move — give the board back to the player
    restorePlayerMovable()
    return
  }
  const engineMoveSound = classifyMoveSound(engineMove, chess)
  boardAudio.play(engineMoveSound)
  pushHistory({
    fen: chess.fen(),
    lastMove: [engFrom as Key, engTo as Key],
    movedBy: 'engine',
    uciMove: bestmove,
    movesSinceZero: computeMovesSinceZero(engineMove),
    sound: engineMoveSound,
  })

  engineMovePending = true
  cg.move(engFrom as Key, engTo as Key)
  // Only sync the FEN — keep turnColor/dests in "engine turn" state so the
  // player cannot make regular moves while engineMovePending is still true.
  // Setting dests here would let Chessground accept a click as a real move,
  // which onAfterMove would ignore (engineMovePending guard), desyncing the
  // visual board from chess.js and silently eating the queued premove.
  setCgState({ fen: boardFen(chess.fen()) })
  await new Promise<void>((resolve) => setTimeout(resolve, 5))
  engineMovePending = false

  const engineResult = determineResult('engine')
  if (engineResult !== null) {
    endGame(engineResult)
    return
  }

  restorePlayerMovable()
  cg.playPremove()
}

// Races the engine/tablebase for a reply and applies it, shared by the normal
// post-player-move flow and by leaveAnalysisMode() when analysis is left with
// the computer on move.
async function triggerEngineTurn(gen: number, isPremove = false): Promise<void> {
  if (!chess || !cg) return
  const { bestmove, evalResult, tbData } = await raceForBestMove(chess.fen(), isPremove)

  if (moveGeneration !== gen || !chess || !cg) return

  checkExerciseFailure(evalResult, tbData)

  if (!bestmove) {
    restorePlayerMovable()
    return
  }

  if (
    shouldAutoSolve(chess.fen(), evalResult.scoreCP, evalResult.scoreMate, tbData?.category ?? null)
  ) {
    endGame('win')
    return
  }

  await applyEngineReply(bestmove)
}

async function processPlayerMove(
  orig: Key,
  dest: Key,
  forcedPromotion?: PromotionPiece,
  isPremove = false,
): Promise<void> {
  if (!chess || !cg) return

  const gen = moveGeneration
  const needsPromotion = isPromotionMove(chess, orig as string, dest as string)

  let promotion: PromotionPiece | undefined = forcedPromotion
  if (needsPromotion && !forcedPromotion) {
    const chosen = await awaitPromotionChoice(gen, orig, dest)
    if (chosen === null) return
    promotion = chosen
  }

  let playerMove: Move
  try {
    playerMove = chess.move({ from: orig as string, to: dest as string, promotion })
  } catch {
    // Premove became illegal after the engine's reply — restore the board so the player can retry
    const lastEntry = historyEntries.value[historyIndex.value]
    setCgState({
      fen: boardFen(chess.fen()),
      lastMove: lastEntry?.lastMove,
      turnColor: playerColor,
      movable: { color: playerColor, free: false, dests: buildDests(chess) },
    })
    return
  }
  const playerMoveSound = classifyMoveSound(playerMove, chess)
  boardAudio.play(playerMoveSound)

  if (isViewingHistory()) {
    historyEntries.value = historyEntries.value.slice(0, historyIndex.value + 1)
    if (!isAnalysisMode.value) isGameOver.value = false
  }
  pushHistory({
    fen: chess.fen(),
    lastMove: [orig, dest],
    movedBy: 'player',
    uciMove: orig + dest + (promotion ?? ''),
    movesSinceZero: computeMovesSinceZero(playerMove),
    sound: playerMoveSound,
  })

  if (isAnalysisMode.value) {
    setCgState({
      fen: boardFen(chess.fen()),
      lastMove: [orig, dest],
      turnColor: toColor(chess.turn()),
      movable: { color: 'both', free: false, dests: buildDests(chess) },
    })
    onPositionChanged()
    return
  }

  const playerResult = determineResult('player')
  if (playerResult !== null) {
    setCgState({ fen: boardFen(chess.fen()), lastMove: [orig, dest] })
    endGame(playerResult)
    return
  }

  setCgState({
    fen: boardFen(chess.fen()),
    lastMove: [orig, dest],
    turnColor: toColor(chess.turn()),
    movable: { color: playerColor, free: false, dests: new Map() },
  })
  isWaitingForEngineReply.value = true
  await triggerEngineTurn(gen, isPremove)
}

function onAfterMove(orig: Key, dest: Key, metadata: MoveMetadata): void {
  if (engineMovePending) return
  if (isViewingHistory() && !isAnalysisMode.value && !canResumeFromHistory()) return
  processPlayerMove(orig, dest, undefined, metadata.premove)
}

const canJumpBack = computed(() => historyIndex.value > 0)
const canJumpForward = computed(() => historyIndex.value < historyEntries.value.length - 1)

function stepBack(): void {
  if (!canJumpBack.value) return
  const leaving = historyEntries.value[historyIndex.value]
  historyIndex.value--
  showHistoryPosition(leaving)
}

function stepForward(): void {
  if (!canJumpForward.value) return
  historyIndex.value++
  showHistoryPosition()
}

function jumpToStart(): void {
  if (!canJumpBack.value) return
  historyIndex.value = 0
  showHistoryPosition()
}

function jumpToEnd(): void {
  if (!canJumpForward.value) return
  historyIndex.value = historyEntries.value.length - 1
  showHistoryPosition()
}

const isFindingBestMove = ref(false)

// Outside analysis mode there's no running analysis to read a "best" move off of, so it's
// resolved the same way a computer reply is: race the engine against the tablebase — but
// always take the tablebase's top move (not the weighted-random defensive pick used for
// actual computer replies), since this button is meant to show the objectively best move.
async function resolveBestMoveUci(): Promise<string | null> {
  if (!chess) return null
  const currentFen = chess.fen()
  const { fen: startFen, moves } = getPositionArgs()
  const [engineResult, tbResult] = await Promise.allSettled([
    engine.getBestMove(startFen, moves),
    shouldQueryTablebase(currentFen) ? tablebase.query(currentFen) : Promise.resolve(null),
  ])
  const tbMove = tbResult.status === 'fulfilled' ? (tbResult.value?.moves[0]?.uci ?? null) : null
  if (tbMove) return tbMove
  return engineResult.status === 'fulfilled' ? engineResult.value.bestMove : null
}

const canPlayBestMove = computed(() => {
  if (props.isRatedAttempt) return false
  // Game-over/history-position checks don't apply in analysis mode — there, moving is
  // always allowed regardless of how the underlying game (pre-analysis) ended.
  if (isAnalysisMode.value) return !!(bestTablebaseMoveUci.value ?? bestEngineMoveUci.value)
  if (isGameOver.value || isViewingHistory()) return false
  return !isWaitingForEngineReply.value
})

async function playBestMove(): Promise<void> {
  if (!canPlayBestMove.value || isFindingBestMove.value) return
  if (isAnalysisMode.value) {
    const bestUci = bestTablebaseMoveUci.value ?? bestEngineMoveUci.value
    if (bestUci) makeMove(bestUci)
    return
  }
  const gen = moveGeneration
  isFindingBestMove.value = true
  const bestUci = await resolveBestMoveUci()
  isFindingBestMove.value = false
  if (moveGeneration !== gen || !bestUci) return
  const orig = bestUci.slice(0, 2) as Key
  const dest = bestUci.slice(2, 4) as Key
  const promotion = bestUci[4] as PromotionPiece | undefined
  await processPlayerMove(orig, dest, promotion)
}

function onKeyDown(e: KeyboardEvent): void {
  if (!cg) return
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  if (e.key === 'ArrowLeft') {
    e.preventDefault()
    stepBack()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    stepForward()
  } else if (e.code === 'Space') {
    e.preventDefault()
    playBestMove()
  }
}

// Deliberately leaves the board exactly where it is — jumping to move 0 caused vertigo when
// the user only wanted to glance at the last few moves. A "First Move" nav button already
// covers the case where they do want the start.
function enterAnalysisMode(startPaused = false): void {
  if (!chess || !cg) return
  analysisPaused.value = startPaused
  isAnalysisMode.value = true
  cg.set({
    movable: { color: 'both', free: false, dests: buildDests(chess) },
  })
  onPositionChanged()
}

// Resumes normal (unrated) play from whatever position analysis happened to be showing,
// discarding any analysis-only continuation beyond it. If the computer is on move there,
// it needs to be nudged to reply so play can continue from the player's side.
function leaveAnalysisMode(): void {
  if (!chess || !cg) return
  cancelPendingPromotion()
  engine.stopAnalysis()
  moveGeneration++
  const gen = moveGeneration
  isAnalysisMode.value = false
  analysisPaused.value = false
  resetAnalysisArrows()
  historyEntries.value = historyEntries.value.slice(0, historyIndex.value + 1)

  updateGameEndDisplay(chess.fen())
  isGameOver.value = gameEndInfo.value !== null

  if (isGameOver.value) {
    cg.set({ movable: { color: undefined } })
    return
  }

  if (toColor(chess.turn()) === playerColor) {
    restorePlayerMovable()
    return
  }

  cg.set({
    turnColor: toColor(chess.turn()),
    movable: { color: playerColor, free: false, dests: new Map() },
  })
  isWaitingForEngineReply.value = true
  void triggerEngineTurn(gen)
}

function loadFen(fen: string): boolean {
  if (!boardEl.value) return false
  let parsed: Chess
  try {
    parsed = new Chess(fen)
  } catch {
    return false
  }

  setupBoard(parsed.fen())
  if (!chess || !cg) return false
  isAnalysisMode.value = true
  cg.set({ movable: { color: 'both', free: false, dests: buildDests(chess) } })
  onPositionChanged()
  return true
}

onMounted(() => {
  setupBoard(props.fen)
  document.addEventListener('keydown', onKeyDown)
})
watch(() => props.fen, setupBoard)
watch(
  () => props.analysisSettings,
  () => {
    if (!isAnalysisMode.value) return
    updateAutoShapes()
    onPositionChanged()
  },
  { deep: true },
)
onUnmounted(() => {
  cancelPendingPromotion()
  moveGeneration++
  arrowInsetObserver?.disconnect()
  arrowInsetObserver = null
  cg?.destroy()
  cg = null
  chess = null
  document.removeEventListener('keydown', onKeyDown)
  clearTimeout(pinnedTooltipTimeout)
})

defineExpose({
  resetBoard,
  takeBack,
  hasMoves,
  enterAnalysisMode,
  leaveAnalysisMode,
  loadFen,
  makeMove,
  showMoveArrow,
  setAnalysisPaused,
  displayMovesSinceZero,
  pinnedTooltip,
  toggleTooltip,
  canJumpBack,
  canJumpForward,
  canPlayBestMove,
  isFindingBestMove,
  jumpToStart,
  jumpToEnd,
  stepBack,
  stepForward,
  playBestMove,
})
</script>

<template>
  <div class="board-container">
    <div ref="boardEl" class="cg-wrap board" />
    <template v-if="gameEndInfo">
      <div class="king-badge-square" :style="whiteKingBadgeStyle">
        <svg class="king-badge" :class="gameEndInfo.whiteBadge" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="46" />
          <text x="50" y="50" dominant-baseline="central" text-anchor="middle">
            {{ KING_BADGE_LABELS[gameEndInfo.whiteBadge] }}
          </text>
        </svg>
      </div>
      <div class="king-badge-square" :style="blackKingBadgeStyle">
        <svg class="king-badge" :class="gameEndInfo.blackBadge" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="46" />
          <text x="50" y="50" dominant-baseline="central" text-anchor="middle">
            {{ KING_BADGE_LABELS[gameEndInfo.blackBadge] }}
          </text>
        </svg>
      </div>
      <div :key="gameEndAnimationKey" class="game-end-reason">
        <span class="game-end-reason-main">{{ gameEndInfo.reasonLines[0] }}</span>
        <span v-if="gameEndInfo.reasonLines[1]" class="game-end-reason-sub">
          {{ gameEndInfo.reasonLines[1] }}
        </span>
      </div>
    </template>
    <template v-if="pendingPromotion">
      <div class="promotion-backdrop" />
      <div class="promotion-picker cg-wrap" :style="promotionPickerStyle">
        <div
          v-for="opt in PROMOTION_OPTIONS"
          :key="opt.piece"
          class="promo-cell"
          :title="t((s) => s.board.promotion[opt.name])"
          @click="selectPromotion(opt.piece)"
        >
          <piece :class="[pendingPromotion.color, opt.name]" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.board-container {
  position: relative;
  width: 100%;
  aspect-ratio: 1;
  container-type: inline-size;
}

.board {
  position: absolute;
  inset: 0;
}

.promotion-backdrop {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: rgba(0, 0, 0, 0.35);
}

.promotion-picker {
  position: absolute;
  z-index: 11;
  width: 12.5%;
  height: 50%;
  display: flex;
  flex-direction: column;
  border-radius: 4px;
  box-shadow:
    0 0 0 2px rgba(0, 0, 0, 0.35),
    0 4px 20px rgba(0, 0, 0, 0.4);
  overflow: hidden;
}

.promo-cell {
  flex: 1;
  position: relative;
  cursor: pointer;
  background: #ece4d6;
  transition: background 0.1s;
}

.promo-cell:hover {
  background: #ffffff;
  box-shadow: inset 0 0 0 2px var(--accent, #dca200);
}

.promo-cell piece {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-size: cover;
  pointer-events: none;
}

.king-badge-square {
  position: absolute;
  width: 12.5%;
  height: 12.5%;
  pointer-events: none;
  z-index: 5;
}

.king-badge {
  position: absolute;
  top: 4%;
  right: 4%;
  width: 44%;
  height: 44%;
  overflow: visible;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.4));
  animation: king-badge-pop 0.35s ease-out;
}

.king-badge circle {
  stroke: rgba(0, 0, 0, 0.45);
  stroke-width: 6;
}

.king-badge text {
  fill: #fff;
  font-weight: 800;
  font-size: 62px;
}

.king-badge.draw text {
  font-size: 44px;
}

.king-badge.win circle {
  fill: #22c55e;
}

.king-badge.loss circle {
  fill: #dc2626;
}

.king-badge.draw circle {
  fill: #9ca3af;
}

@keyframes king-badge-pop {
  from {
    transform: scale(0);
    opacity: 0;
  }

  to {
    transform: scale(1);
    opacity: 1;
  }
}

.game-end-reason {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 8%;
  color: #fff;
  text-shadow:
    0 0 12px rgba(0, 0, 0, 0.8),
    0 2px 4px rgba(0, 0, 0, 0.6);
  pointer-events: none;
  opacity: 0;
  animation: game-end-reason-fade 5s ease-out forwards;
}

.game-end-reason-main {
  font-size: 12.5cqw;
  font-weight: 800;
}

.game-end-reason-sub {
  font-size: 6.5cqw;
  font-weight: 600;
  opacity: 0.9;
}

@keyframes game-end-reason-fade {
  0% {
    opacity: 0;
    transform: scale(0.7);
  }

  12% {
    opacity: 1;
    transform: scale(1);
  }

  80% {
    opacity: 1;
    transform: scale(1);
  }

  100% {
    opacity: 0;
    transform: scale(1.1);
  }
}
</style>
