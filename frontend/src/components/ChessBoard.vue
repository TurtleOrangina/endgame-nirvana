<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Chessground } from '@lichess-org/chessground'
import type { Api } from '@lichess-org/chessground/api'
import type { DrawShape } from '@lichess-org/chessground/draw'
import type { BrushColor, Key, MoveMetadata } from '@lichess-org/chessground/types'
import { Chess, type Move, type Square } from 'chess.js'
import {
  FAILURE_RECHECK_THINKING_TIME_MS,
  useStockfishEngine,
} from '@/composables/useStockfishEngine'
import { useBoardAudio, type BoardSound } from '@/composables/useBoardAudio'
import { useLichessTablebase } from '@/composables/useLichessTablebase'
import { useLocale } from '@/composables/useLocale'
import { useMoveSelector, type MoveSelectionResult } from '@/composables/useMoveSelector'
import { evaluatePuzzleGoal } from '@/utils/puzzleEvaluation'
import {
  hasPawnsOnBoard,
  isBareKingVsMajorPiece,
  isMirroredMajorPieceEndgame,
  MIN_ELO_MAJOR_PIECE_VS_KING_IS_WON,
  uciToMoveArgs,
} from '@/utils/chess'
import { useUserProfileStore } from '@/stores/userProfile'
import { useExercisesStore } from '@/stores/exercises'
import type { BoardHistoryEntry, BoardSnapshot } from '@/utils/trainingSessionState'
import type {
  GameResult,
  PlayerColor,
  EngineLine,
  TablebaseCategory,
  TablebaseResult,
  AnalysisSettings,
} from '@/types'

type PromotionPiece = 'q' | 'r' | 'n' | 'b'

// Shape lives in trainingSessionState.ts so the whole history can be serialized into a
// session snapshot as-is. On isOutsideGoal: it's the goal verdict of a position once
// evaluated (player-move positions and game ends); undefined = never directly evaluated —
// such positions inherit the verdict of the nearest evaluated position before them
// (see displayedIsOutsideGoal).
type HistoryEntry = BoardHistoryEntry

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

const TEMPERATURE = 0.2 // the engine defends accurately
// On pawnless retrys more variance is accepted, to see more variations
const TEMPERATURE_PAWNLESS_RETRY = 0.6

// User-drawn arrows/marked squares are coloured by the modifier keys held when the
// right-click drag starts — every combination of Ctrl/Alt/Shift gets its own colour, see
// userArrowColorForEvent. Chessground's built-in modifier-to-brush mapping only has four
// slots and can't tell Shift and Ctrl apart, so we pick the brush ourselves — see
// attachUserShapeColorOverride — instead of relying on it.
// The unmodified and Shift-free combinations carry the colours worth reaching quickly:
// Firefox lets Shift+right-click bypass a page's contextmenu handler, so every Shift
// binding pops the native menu unless drawn with a left-drag instead.
type UserBrushName = BrushColor | 'purple' | 'orange' | 'cyan' | 'pink'

const USER_SHAPE_BRUSHES: Record<UserBrushName, { key: string; color: string }> = {
  blue: { key: 'ub', color: '#3b82f6' },
  red: { key: 'ur', color: '#dc2626' },
  green: { key: 'ug', color: '#22c55e' },
  yellow: { key: 'uy', color: '#e6b800' },
  purple: { key: 'up', color: '#a855f7' },
  orange: { key: 'uo', color: '#f97316' },
  cyan: { key: 'uc', color: '#06b6d4' },
  pink: { key: 'un', color: '#ec4899' },
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
  // While true (e.g. the setup modal is open in front of the board), the "You play
  // white/black" intro is held back; it plays once the flag drops, since the CSS
  // animation starts when the element enters the DOM.
  suppressIntro: boolean
}>()

const emit = defineEmits<{
  'game-over': [result: GameResult]
  'goal-evaluated': [isOutsideGoal: boolean, wasAlreadyOutsideGoal: boolean]
  'analysis-update': [lines: EngineLine[], tablebaseResult: TablebaseResult | null, fen: string]
}>()

const boardEl = ref<HTMLElement | null>(null)
const promotionPickerEl = ref<HTMLElement | null>(null)
// Chessground completes a click-move on pointer-down, so the very event that opens the
// picker would otherwise register as a click outside it and abort the move immediately.
let promotionOpenedAt = 0
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
const moveSelector = useMoveSelector()

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

function recordGoalVerdict(fen: string, isOutsideGoal: boolean): void {
  const entries = historyEntries.value
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry?.fen === fen) {
      entry.isOutsideGoal = isOutsideGoal
      return
    }
  }
}

// The verdict `fen` inherits from the positions leading up to it, i.e. whether the player
// was already off course before the move that reached it. Takebacks and history navigation
// mean an evaluation can happen on a fresh branch that starts from an on-track position,
// so this — not the previous evaluation — decides whether a wrong move is a *new* mistake.
function goalVerdictBefore(fen: string): boolean {
  const entries = historyEntries.value
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.fen !== fen) continue
    for (let j = i - 1; j >= 0; j--) {
      const verdict = entries[j]?.isOutsideGoal
      if (verdict !== undefined) return verdict
    }
    break
  }
  return false
}

// Whether the currently displayed position counts as off-course, so the "Wrong solution"
// indicator can follow history navigation: stepping back to a position that was still on
// track hides it, stepping forward past the mistake brings it back.
const displayedIsOutsideGoal = computed(() => {
  for (let i = historyIndex.value; i >= 0; i--) {
    const verdict = historyEntries.value[i]?.isOutsideGoal
    if (verdict !== undefined) return verdict
  }
  return false
})
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

// The player's own pawns promote on the far edge of the board (the board is always
// oriented for the player), the opponent's on the near edge.
const isPromotionPickerAtTop = computed(
  () => !!pendingPromotion.value && playerColor === pendingPromotion.value.color,
)

const promotionPickerStyle = computed(() => {
  if (!pendingPromotion.value) return {}
  const fileIndex = (pendingPromotion.value.dest as string).charCodeAt(0) - 97
  const col = playerColor === 'white' ? fileIndex : 7 - fileIndex
  const atTop = isPromotionPickerAtTop.value
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

function fenTurnColor(fen: string): PlayerColor {
  return fen.split(' ')[1] === 'b' ? 'black' : 'white'
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
      ? USER_SHAPE_BRUSHES[brush as UserBrushName].color
      : USER_SHAPE_BRUSHES.blue.color
  return hexToRgba(color, SQUARE_TINT_ALPHA)
}

// Chessground's own eventBrush() picks a brush from the modifier keys held at drag-start,
// but conflates Shift and Ctrl into the same slot — so we override the brush it picked
// right after mousedown, using our own mapping instead.
// Most-specific combination first, so a two- or three-key chord isn't swallowed by the
// single-modifier case it contains.
function userArrowColorForEvent(e: MouseEvent): UserBrushName {
  if (e.ctrlKey && e.altKey && e.shiftKey) return 'pink'
  if (e.ctrlKey && e.altKey) return 'yellow'
  if (e.ctrlKey && e.shiftKey) return 'orange'
  if (e.altKey && e.shiftKey) return 'cyan'
  if (e.altKey) return 'red'
  if (e.ctrlKey) return 'green'
  if (e.shiftKey) return 'purple'
  return 'blue'
}

function attachUserShapeColorOverride(boardCg: HTMLElement): void {
  boardCg.addEventListener(
    'mousedown',
    (e) => {
      const current = cg?.state.drawable.current
      // Chessground types the in-progress brush as its four built-in slots, but looks it
      // up in an open-ended brushes record — so a brush of ours renders fine.
      if (current) current.brush = userArrowColorForEvent(e) as BrushColor
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
  if (userElo <= MIN_ELO_MAJOR_PIECE_VS_KING_IS_WON) return false
  if (evaluatePuzzleGoal('win', scoreCP, scoreMate, tablebaseCategory).isOutsideGoal) return false
  const initialFen = historyEntries.value[0]?.fen
  if (initialFen && isBareKingVsMajorPiece(initialFen, playerColor)) return false
  return isBareKingVsMajorPiece(fen, playerColor)
}

// How far into the computer's intended line the draw auto-solve looks for a reason to
// keep playing: the move it is about to play and the user reply the engine predicts.
const AUTO_DRAW_LOOKAHEAD_HALFMOVES = 2

// Whether the given half-moves change nothing that's worth watching on the board: no
// capture and no game end along the way. An illegal (e.g. truncated) line counts as
// eventful, so a line that can't be verified never triggers the auto-solve.
function isUneventfulContinuation(fen: string, uciMoves: string[]): boolean {
  const chess = new Chess(fen)
  for (const uci of uciMoves.slice(0, AUTO_DRAW_LOOKAHEAD_HALFMOVES)) {
    let move: Move
    try {
      move = chess.move(uciToMoveArgs(uci))
    } catch {
      return false
    }
    if (move.isCapture() || move.isEnPassant()) return false
    if (chess.isGameOver()) return false
  }
  return true
}

// Auto-solves as a draw once a draw-goal puzzle has been reduced to king and rook (or
// king and queen) on both sides: the position holds itself, so playing on is shuffling.
// Held back while something is still about to happen — a capture would change the
// material this verdict rests on, and a stalemate or 50-move end within the next two
// half-moves is the actual end of the game, which the player should see played out.
function shouldAutoDraw(fen: string, selection: MoveSelectionResult): boolean {
  if (useExercisesStore().currentExercise?.expectedResult !== 'draw') return false
  if (!isMirroredMajorPieceEndgame(fen)) return false
  const { isOutsideGoal } = evaluatePuzzleGoal(
    'draw',
    selection.scoreCP,
    selection.scoreMate,
    selection.tbData?.category ?? null,
  )
  if (isOutsideGoal) return false

  // The line of the move the computer is actually about to play — a capture in it is one
  // the player would see land on the board, not a hypothetical from some other candidate
  const intendedMoves = selection.selectedLine?.moves ?? []
  if (intendedMoves.length === 0) return false
  return isUneventfulContinuation(fen, intendedMoves)
}

function shouldQueryTablebase(fen: string): boolean {
  return countPieces(fen) <= 8
}

const bestEngineMoveUci = ref<string | null>(null)
const bestTablebaseMoveUci = ref<string | null>(null)
const hoveredMoveUci = ref<string | null>(null)

// The tablebase only speaks authoritatively when it classifies every legal move. An
// 'unknown' overall category means at least one move is off-tablebase (e.g. 8-piece
// positions), so its top move can't be trusted as best — defer to the engine for both the
// arrow and "Play best move".
function authoritativeTablebaseBestUci(result: TablebaseResult | null): string | null {
  if (!result || result.category === 'unknown') return null
  return result.moves[0]?.uci ?? null
}

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

// Shown when a fresh exercise is set up, so it's obvious which side the player has —
// disappears as soon as the first move is made (and fades out on its own before that).
const introColor = ref<PlayerColor | null>(null)
const introAnimationKey = ref(0)

const gameEndInfo = ref<GameEndInfo | null>(null)
const isShowingGameEndText = computed(() => gameEndInfo.value !== null)
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
  const expectedResult = useExercisesStore().currentExercise?.expectedResult
  if (expectedResult) recordGoalVerdict(chess.fen(), result !== expectedResult)
  updateGameEndDisplay(chess.fen())
  emit('game-over', result)
}

// Outside analysis mode, browsing history is normally read-only — but while retrying
// (not a rated attempt), the player is allowed to play a different move than they
// originally did, provided it's genuinely their move at that position (never the
// computer's), branching the history from there.
// Read from the displayed entry rather than from `chess`, which is deliberately left
// pointing at the previous position while a non-resumable entry is on screen (see
// showHistoryPosition) and would otherwise report on a position nobody is looking at.
function canResumeFromHistory(): boolean {
  const fen = historyEntries.value[historyIndex.value]?.fen
  if (!fen) return false
  return !props.isRatedAttempt && fenTurnColor(fen) === playerColor
}

// When stepping back, the move being undone is the one recorded on the entry we're
// leaving, so its sound is passed in via `undoneEntry`; when stepping forward, the
// replayed move is the one recorded on the entry we land on.
function showHistoryPosition(undoneEntry?: HistoryEntry, playSound = true): void {
  if (!cg || !chess) return
  const entry = historyEntries.value[historyIndex.value]
  if (!entry) return

  const soundSource = undoneEntry ?? entry
  if (playSound && soundSource.lastMove) {
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
      if (canResumeFromHistory()) {
        chess = new Chess(entry.fen)
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
  promotionOpenedAt = performance.now()
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

// Puts the board back on the position currently in history — used after a move was
// started but never committed (an aborted promotion, an illegal premove), where the
// board is left showing a half-applied move.
function restoreBoardToCurrentPosition(): void {
  if (!chess || !cg) return
  setCgState({
    fen: boardFen(chess.fen()),
    lastMove: historyEntries.value[historyIndex.value]?.lastMove,
    turnColor: toColor(chess.turn()),
    movable: {
      color: isAnalysisMode.value ? 'both' : playerColor,
      free: false,
      dests: buildDests(chess),
    },
  })
}

// Gives up on a promotion the player never picked a piece for: the pawn goes back to
// where it came from and the move is discarded.
function abortPendingPromotion(): void {
  if (!pendingPromotion.value) return
  cancelPendingPromotion()
  restoreBoardToCurrentPosition()
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
  gameOverEntryBeforeAnalysis = null
  isFindingBestMove.value = false
  isWaitingForEngineReply.value = false
  gameEndInfo.value = null
  introColor.value = color
  introAnimationKey.value++

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
      eraseOnMovablePieceClick: true,
      onChange: onDrawableChange,
      brushes: {
        blue: { ...USER_SHAPE_BRUSHES.blue, opacity: 1, lineWidth: 10 },
        red: { ...USER_SHAPE_BRUSHES.red, opacity: 1, lineWidth: 10 },
        green: { ...USER_SHAPE_BRUSHES.green, opacity: 1, lineWidth: 10 },
        yellow: { ...USER_SHAPE_BRUSHES.yellow, opacity: 1, lineWidth: 10 },
        purple: { ...USER_SHAPE_BRUSHES.purple, opacity: 1, lineWidth: 10 },
        orange: { ...USER_SHAPE_BRUSHES.orange, opacity: 1, lineWidth: 10 },
        cyan: { ...USER_SHAPE_BRUSHES.cyan, opacity: 1, lineWidth: 10 },
        pink: { ...USER_SHAPE_BRUSHES.pink, opacity: 1, lineWidth: 10 },
        engineBest: { key: 'eb', color: '#6b7280', opacity: 0.8, lineWidth: 10 },
        tablebaseBest: { key: 'tb', color: '#e6c200', opacity: 0.8, lineWidth: 10 },
        moveHover: { key: 'mh', color: '#22c55e', opacity: 0.8, lineWidth: 10 },
      },
    },
  })
  attachBoardDomHooks()
}

// Everything we hang off Chessground's own DOM. Chessground rebuilds that DOM from
// scratch — new cg-board, new shapes group — on construction *and* on every redrawAll,
// so these have to be re-attached each time or they silently keep pointing at the
// discarded nodes (which is how user arrows lost their colour override and their inset).
function attachBoardDomHooks(): void {
  observeUserArrows()
  const boardCg = boardEl.value?.querySelector<HTMLElement>('cg-board')
  if (boardCg) attachUserShapeColorOverride(boardCg)
}

function resetBoard(): void {
  cancelPendingPromotion()
  setupBoard(props.fen)
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
          bestTablebaseMoveUci.value = authoritativeTablebaseBestUci(tbResult)
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
    bestTablebaseMoveUci.value = authoritativeTablebaseBestUci(tbResult)
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

async function checkExerciseFailure(
  gen: number,
  fen: string,
  selection: MoveSelectionResult,
): Promise<void> {
  const exercise = useExercisesStore().currentExercise
  if (!exercise) return
  // Captured before the recheck below awaits — the history it reads can be truncated by
  // a takeback in the meantime.
  const wasAlreadyOutsideGoal = goalVerdictBefore(fen)
  const { isOutsideGoal: initialVerdict, isTablebaseVerdict } = evaluatePuzzleGoal(
    exercise.expectedResult,
    selection.scoreCP,
    selection.scoreMate,
    selection.tbData?.category ?? null,
  )
  let isOutsideGoal = initialVerdict

  // The engine's first search only gets ~400ms and can misjudge a position as won/lost
  // when it's actually a known draw (e.g. wrong-coloured bishop with a rook pawn) simply
  // because it hasn't looked deep enough yet. A false "Wrong solution!" here would fail
  // the puzzle even though the player did nothing wrong, so when the verdict came from
  // the engine score rather than an authoritative tablebase category, re-run a short
  // single-line search and only confirm the failure if it agrees.
  if (isOutsideGoal && !isTablebaseVerdict) {
    const recheckLines = await engine
      .getBestMoves(fen, [], FAILURE_RECHECK_THINKING_TIME_MS, 1)
      .catch((): EngineLine[] => [])
    if (moveGeneration !== gen) return
    const recheckLine = recheckLines[0]
    isOutsideGoal = evaluatePuzzleGoal(
      exercise.expectedResult,
      recheckLine?.scoreCP ?? null,
      recheckLine?.scoreMate ?? null,
      null,
    ).isOutsideGoal
  }

  recordGoalVerdict(fen, isOutsideGoal)
  emit('goal-evaluated', isOutsideGoal, wasAlreadyOutsideGoal)
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

// Selects the computer's reply (engine lines filtered/weighted via tablebase — see
// useMoveSelector) and applies it, shared by the normal post-player-move flow and by
// leaveAnalysisMode() when analysis is left with the computer on move.
async function triggerEngineTurn(gen: number, isPremove = false): Promise<void> {
  if (!chess || !cg) return
  const currentFen = chess.fen()
  const { fen: startFen, moves } = getPositionArgs()
  const selection = await moveSelector.getBestMove(startFen, moves, currentFen, {
    temperature:
      !props.isRatedAttempt && !hasPawnsOnBoard(currentFen)
        ? TEMPERATURE_PAWNLESS_RETRY
        : TEMPERATURE,
    isPremove,
    playerColor,
    queryTablebase: shouldQueryTablebase(currentFen),
    shouldAbort: () => moveGeneration !== gen,
  })

  if (moveGeneration !== gen || !chess || !cg) return

  await checkExerciseFailure(gen, currentFen, selection)

  if (moveGeneration !== gen || !chess || !cg) return

  const { bestmove, scoreCP, scoreMate, tbData } = selection
  if (!bestmove) {
    restorePlayerMovable()
    return
  }

  if (shouldAutoSolve(chess.fen(), scoreCP, scoreMate, tbData?.category ?? null)) {
    endGame('win')
    return
  }

  if (shouldAutoDraw(chess.fen(), selection)) {
    endGame('draw')
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
    restoreBoardToCurrentPosition()
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
    engine.getBestMoves(startFen, moves),
    shouldQueryTablebase(currentFen) ? tablebase.query(currentFen) : Promise.resolve(null),
  ])
  const tbMove =
    tbResult.status === 'fulfilled' ? authoritativeTablebaseBestUci(tbResult.value) : null
  if (tbMove) return tbMove
  return engineResult.status === 'fulfilled' ? (engineResult.value[0]?.moves[0] ?? null) : null
}

const canPlayBestMove = computed(() => {
  if (props.isRatedAttempt) return false
  // Game-over/history-position checks don't apply in analysis mode — there, moving is
  // always allowed regardless of how the underlying game (pre-analysis) ended.
  if (isAnalysisMode.value) return !!(bestTablebaseMoveUci.value ?? bestEngineMoveUci.value)
  // While browsing history the button follows the board: enabled exactly where a piece
  // could also be dragged, i.e. at a position the player is to move in — playing from
  // there branches the history off, just as playing the move by hand would. isGameOver
  // is irrelevant then, since the displayed position is the one being resumed, not the
  // finished one.
  if (isViewingHistory()) return canResumeFromHistory()
  if (isGameOver.value) return false
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

function onPointerDownOutsidePromotion(e: Event): void {
  if (!pendingPromotion.value) return
  if (e.timeStamp < promotionOpenedAt) return
  if (e.target instanceof Node && promotionPickerEl.value?.contains(e.target)) return
  abortPendingPromotion()
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta'])

function onKeyDown(e: KeyboardEvent): void {
  if (!cg) return
  // The training view stays mounted (v-show) while other pages are shown — board
  // shortcuts must not fire while the board isn't visible (display:none => null here).
  if (boardEl.value?.offsetParent === null) return
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
  // Any keystroke while the promotion picker is open means the player is done with it:
  // abort the move and swallow the key rather than acting on it behind the picker.
  if (pendingPromotion.value && !MODIFIER_KEYS.has(e.key)) {
    e.preventDefault()
    abortPendingPromotion()
    return
  }
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

// Captured on entering analysis so leaveAnalysisMode can recognize a game that had
// already ended even though the final position isn't terminal (an auto-solved win, see
// shouldAutoSolve). updateGameEndDisplay can't re-derive that from the FEN alone, and
// re-running the engine there would end — and celebrate — the game a second time.
let gameOverEntryBeforeAnalysis: { index: number; fen: string } | null = null

// Deliberately leaves the board exactly where it is — jumping to move 0 caused vertigo when
// the user only wanted to glance at the last few moves. A "First Move" nav button already
// covers the case where they do want the start.
function enterAnalysisMode(startPaused = false): void {
  if (!chess || !cg) return
  const lastIndex = historyEntries.value.length - 1
  const lastEntry = historyEntries.value[lastIndex]
  gameOverEntryBeforeAnalysis =
    isGameOver.value && lastEntry ? { index: lastIndex, fen: lastEntry.fen } : null
  analysisPaused.value = startPaused
  isAnalysisMode.value = true
  // Browsing history outside analysis mode leaves `chess` on the latest position whenever
  // the displayed one isn't resumable, so it must be resynced here — otherwise the board
  // would be unlocked with the dests (and side to move) of a different position.
  const displayedEntry = historyEntries.value[historyIndex.value]
  if (displayedEntry && chess.fen() !== displayedEntry.fen) chess = new Chess(displayedEntry.fen)
  cg.set({
    turnColor: toColor(chess.turn()),
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
  const leavingAtAlreadyFinishedGame =
    gameOverEntryBeforeAnalysis !== null &&
    gameOverEntryBeforeAnalysis.index === historyIndex.value &&
    gameOverEntryBeforeAnalysis.fen === historyEntries.value[historyIndex.value]?.fen
  isGameOver.value = gameEndInfo.value !== null || leavingAtAlreadyFinishedGame

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

function getBoardSnapshot(): BoardSnapshot {
  return {
    entries: historyEntries.value.map((entry) => ({ ...entry })),
    index: historyIndex.value,
    isGameOver: isGameOver.value,
    gameOverEntryBeforeAnalysis,
  }
}

// Rebuilds the board exactly as captured by getBoardSnapshot before a full page load
// (e.g. the Lichess OAuth link flow's round trip): full move history, viewed position,
// game-over state and analysis mode. If the snapshot was taken between the player's
// move and the computer's reply, the reply is re-triggered so the game doesn't hang —
// in that case the latest position is shown even if history was being browsed, since
// the incoming reply would yank the view there anyway.
function restoreBoardSnapshot(
  snapshot: BoardSnapshot,
  analysis: { active: boolean; paused: boolean },
): void {
  const startFen = snapshot.entries[0]?.fen
  if (!startFen) return
  setupBoard(startFen)
  if (!chess || !cg) return

  historyEntries.value = snapshot.entries.map((entry) => ({ ...entry }))
  isGameOver.value = snapshot.isGameOver
  gameOverEntryBeforeAnalysis = snapshot.gameOverEntryBeforeAnalysis
  if (analysis.active) {
    isAnalysisMode.value = true
    analysisPaused.value = analysis.paused
  }

  const lastEntry = historyEntries.value[historyEntries.value.length - 1]
  const engineReplyPending =
    !analysis.active &&
    !snapshot.isGameOver &&
    !!lastEntry &&
    toColor(new Chess(lastEntry.fen).turn()) !== playerColor
  historyIndex.value = engineReplyPending
    ? historyEntries.value.length - 1
    : Math.min(Math.max(snapshot.index, 0), historyEntries.value.length - 1)

  showHistoryPosition(undefined, false)

  if (!engineReplyPending || !chess || !cg) return
  cg.set({
    turnColor: toColor(chess.turn()),
    movable: { color: playerColor, free: false, dests: new Map() },
  })
  isWaitingForEngineReply.value = true
  void triggerEngineTurn(moveGeneration)
}

// Chessground caches the board's pixel bounds; if the window is resized while the
// training view is hidden (v-show), those go stale — re-measure when it's shown again.
function redraw(): void {
  if (!cg) return
  cg.redrawAll()
  attachBoardDomHooks()
  // Chessground redraws its own shapes from state, but the square tints are ours and
  // were wiped with the old cg-board — without an onChange to rebuild them.
  applySquareTints(cg.state.drawable.shapes)
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
  document.addEventListener('mousedown', onPointerDownOutsidePromotion)
  document.addEventListener('touchstart', onPointerDownOutsidePromotion)
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
  document.removeEventListener('mousedown', onPointerDownOutsidePromotion)
  document.removeEventListener('touchstart', onPointerDownOutsidePromotion)
  clearTimeout(pinnedTooltipTimeout)
})

defineExpose({
  isShowingGameEndText,
  displayedIsOutsideGoal,
  resetBoard,
  hasMoves,
  enterAnalysisMode,
  leaveAnalysisMode,
  loadFen,
  getBoardSnapshot,
  restoreBoardSnapshot,
  redraw,
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
    <div
      v-if="introColor && !suppressIntro && !hasMoves && !isAnalysisMode && !gameEndInfo"
      :key="introAnimationKey"
      class="game-intro"
      :class="introColor"
    >
      {{ introColor === 'white' ? t((s) => s.app.youPlayWhite) : t((s) => s.app.youPlayBlack) }}
    </div>
    <template v-if="pendingPromotion">
      <div class="promotion-backdrop" />
      <div
        ref="promotionPickerEl"
        class="promotion-picker cg-wrap"
        :class="{ 'from-bottom': !isPromotionPickerAtTop }"
        :style="promotionPickerStyle"
      >
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

/* The queen (first option) must always sit on the promotion square itself, so clicking
   again without moving picks it — that means growing away from the board's near edge. */
.promotion-picker.from-bottom {
  flex-direction: column-reverse;
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

.game-intro {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 0 8%;
  font-size: 10cqw;
  font-weight: 800;
  pointer-events: none;
  opacity: 0;
  animation: game-end-reason-fade 3s ease-out forwards;
}

.game-intro.white {
  color: #fff;
  text-shadow:
    0 0 12px rgba(0, 0, 0, 0.8),
    0 2px 4px rgba(0, 0, 0, 0.6);
}

.game-intro.black {
  color: #000;
  text-shadow:
    0 0 12px rgba(255, 255, 255, 0.8),
    0 2px 4px rgba(255, 255, 255, 0.6);
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
