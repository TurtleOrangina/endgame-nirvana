import { Chess } from 'chess.js'
import type { EngineLine, PlayerColor } from '@/types'
import type { StockfishEngine } from '@/composables/useStockfishEngine'
import {
  PRODUCTION_TUNING,
  useMoveSelector,
  type MoveSelectionResult,
  type SelectorTuning,
} from '@/composables/useMoveSelector'
import { isAutoDraw, isAutoWin, type AutoResolveContext } from '@/utils/autoResolve'
import { engineMaintainFraction } from '@/utils/maintainFraction'
import { materialByColor, uciToMoveArgs } from '@/utils/chess'
import { scoreToOutcome } from '@/utils/puzzleEvaluation'
import { MIN_TEMPERATURE } from '@/utils/weightedSample'
import { countPieces } from '@/measurements/shared/puzzleCatalog'
import type { TablebaseClient } from '@/measurements/shared/tablebaseClient'
import {
  TRICKINESS_MULTIPV,
  TRICKINESS_THINKING_TIME_MS,
  USER_MOVE_THINKING_TIME_MS,
} from './strongEngine'
import { userColorOf, type PlayoutPuzzle } from './playoutPuzzleSelection'

// A playout that hasn't resolved by here is shuffling in a position neither side can make
// progress in; the 50-move rule normally ends it long before.
const MAX_PLIES = 400

// The app queries the tablebase up to this size (ChessBoard.vue's shouldQueryTablebase),
// so the playout does too — a defender that silently loses its tablebase access would be
// a different opponent from the one users face.
const TABLEBASE_MAX_PIECES = 8

// A high rating, so the win auto-solve isn't gated off (see isAutoWin): the playout's user
// is a strong engine, and K+Q vs K is not training for anyone at this level.
const MEASURED_USER_ELO = 2500

export type PlayoutEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient-material'
  | 'threefold-repetition'
  | 'fifty-move-rule'
  | 'auto-win'
  | 'auto-draw'
  | 'selector-gave-no-move'
  | 'ply-limit-reached'
  // Not how the playout ended but how the *scored* line ends: the converted tail was cut
  // (see playoutTrimming), so whatever happened afterwards no longer counts as defense
  | 'material-truncated'

export interface PlayoutPly {
  side: 'user' | 'defender'
  // The position the move was played from
  fenBefore: string
  san: string
  // How far ahead the user was, in pawns, before this move — only meaningful on user plies
  userMaterialBalance: number
  // Weighted fraction of the user's moves that would *not* have held the result here,
  // i.e. how easy this position was to go wrong in. User plies only.
  trickiness: number | null
}

export interface PlayoutResult {
  endReason: PlayoutEndReason
  plies: PlayoutPly[]
  finalFen: string
  // How long the defender took over each move it produced, including the last one, which
  // an auto-solve may have made moot. Excludes the harness's own awaited tablebase
  // pre-warm: the app never waits for that lookup, so it is not time the opponent costs.
  defenderMoveTimesMs: number[]
  // Distinct positions the tablebase was consulted about while choosing each of those moves.
  // Zero means the defender played that move on engine evaluation alone — which is what a
  // position too big for any tablebase looks like, and what a broken tablebase would look
  // like everywhere.
  defenderTablebaseLookups: number[]
}

/**
 * Which opponent is being measured. Everything about the playout apart from this — the user
 * engine, the done detection, the trimming, the trickiness measurement — must stay identical
 * across kinds, or a comparison stops isolating the defender. See CLAUDE.md's "Adding a
 * defender to compare against".
 *
 * - `move-selector` — the app's real one.
 * - `engine-best-move` — the floor: one 800 ms multipv-1 search on the same multithreaded
 *   WASM build, top line played. No tablebase, no delayer, no Trickster, no sampling; what the
 *   app would be if `useMoveSelector` didn't exist.
 * - `offline` — the shipped selector with the same shipped tuning, but every
 *   tablebase request fails, as it does for a user with no connection. The selector still asks
 *   (that is what the app does offline) and still has to defend on the engine search alone,
 *   so this measures what a user loses by playing offline.
 */
export type DefenderKind = 'move-selector' | 'engine-best-move' | 'offline'

export const SELECTOR_TUNINGS: Record<DefenderKind, SelectorTuning> = {
  'move-selector': PRODUCTION_TUNING,
  // `engine-best-move` never builds a selector; the entry exists so every kind can be looked
  // up here (the divergence study does), not because this tuning is used
  'engine-best-move': PRODUCTION_TUNING,
  // Deliberately the shipped tuning: what differs offline is the information, not the logic
  offline: PRODUCTION_TUNING,
}

/**
 * The bare engine defender's search budget, deliberately twice `useMoveSelector`'s own
 * `DEFAULT_BEST_MOVE_THINKING_TIME_MS`: the selector spends its extra time on the Trickster's
 * probes rather than on a deeper best-move search, and this arm is meant to answer "would the
 * position simply be defended better by thinking longer about the top move?" — so it is given
 * a comparable total, not a comparably deep first search.
 */
const ENGINE_BEST_MOVE_THINKING_TIME_MS = 800

/**
 * The measurement drives the selector at `MIN_TEMPERATURE`: it then always plays its
 * highest-weighted candidate, and still samples between candidates the weighting rates
 * exactly equal. That is deliberately *not* how the app behaves — the variance the app's
 * temperature buys is what keeps a puzzle worth replaying — but a comparison is trying to
 * find out which weighting defends better, and letting each run roll its own dice only adds
 * a noise source on top of the two time-limited engines. The sampling is a property of the
 * opponent rather than of the weighting, so it is held fixed.
 */
const DEFENDER_TEMPERATURE = MIN_TEMPERATURE

export interface PlayoutOptions {
  puzzle: PlayoutPuzzle
  defenderEngine: StockfishEngine
  strongEngine: StockfishEngine
  tablebase: TablebaseClient
  defenderKind?: DefenderKind
}

function toColor(turn: string): PlayerColor {
  return turn === 'w' ? 'white' : 'black'
}

// Material from the user's point of view: their pieces minus the defender's
function userMaterialBalance(fen: string, playerColor: PlayerColor): number {
  const material = materialByColor(fen)
  return playerColor === 'white' ? material.white - material.black : material.black - material.white
}

// End reasons that mean the game was drawn. For a win-goal puzzle every one of them is the
// user engine failing to convert.
const DRAWN_END_REASONS = new Set<PlayoutEndReason>([
  'threefold-repetition',
  'stalemate',
  'insufficient-material',
  'fifty-move-rule',
  'auto-draw',
])

/**
 * Whether the strong engine standing in for the user failed to reach the puzzle's goal, and
 * in what way. This should never happen: it is a perfect-play stand-in with Syzygy access,
 * so a drawn win or a loss means the measurement itself is broken — a bad engine setup, a
 * mislabelled puzzle, or a bug in how the engine is driven — and every number the run
 * produces for that puzzle is measuring that instead of the defender. Loud by design.
 *
 * Judged on the *untrimmed* playout: trimming rewrites the end reason for scoring, and a
 * `material-truncated` line says nothing about how the game actually finished.
 */
export function strongEngineGoalFailure(
  puzzle: Pick<PlayoutPuzzle, 'fen' | 'goal' | 'defenderToMoveFirst'>,
  playout: PlayoutResult,
): string | null {
  const playerColor = userColorOf(puzzle)
  if (playout.endReason === 'checkmate') {
    // The side to move in the final position is the one that got mated
    const matedColor = toColor(new Chess(playout.finalFen).turn())
    return matedColor === playerColor ? 'was checkmated' : null
  }
  // A draw-goal puzzle is only failed by losing, which the checkmate branch above covers
  if (puzzle.goal !== 'win') return null
  if (DRAWN_END_REASONS.has(playout.endReason)) return `drew a won position (${playout.endReason})`
  if (playout.endReason === 'ply-limit-reached') return 'never converted (hit the ply limit)'
  if (playout.endReason === 'selector-gave-no-move') return 'produced no move'
  return null
}

function terminalEndReason(chess: Chess): PlayoutEndReason | null {
  if (chess.isCheckmate()) return 'checkmate'
  if (chess.isStalemate()) return 'stalemate'
  if (chess.isInsufficientMaterial()) return 'insufficient-material'
  if (chess.isThreefoldRepetition()) return 'threefold-repetition'
  if (chess.isDrawByFiftyMoves()) return 'fifty-move-rule'
  return null
}

// The engine lines at a user-to-move position, seen from the defender's side of the board
// after the user plays that line's first move — the shape isAutoWin/isAutoDraw expect,
// since the app only ever evaluates them with the computer to move and the computer's own
// scores. The rest of the line is what the defender would intend from there.
function asDefenderSelection(line: EngineLine): MoveSelectionResult {
  return {
    bestmove: line.moves[1] ?? null,
    scoreCP: line.scoreCP === null ? null : -line.scoreCP,
    scoreMate: line.scoreMate === null ? null : -line.scoreMate,
    tbData: null,
    selectedLine: { ...line, moves: line.moves.slice(1) },
  }
}

/**
 * Plays one puzzle out: a strong engine as the user against `useMoveSelector` as the
 * defender, until the position is done — either really over, or resolved by the same
 * auto-win/auto-draw rules the board applies (including one the user could have reached
 * with a legal move of their own, which they would have played).
 */
export async function playOutPuzzle(options: PlayoutOptions): Promise<PlayoutResult> {
  const { puzzle, defenderEngine, strongEngine, tablebase } = options
  const startFen = puzzle.fen
  const chess = new Chess(startFen)
  const playerColor = userColorOf(puzzle)
  const moveSelector = useMoveSelector(
    defenderEngine,
    SELECTOR_TUNINGS[options.defenderKind ?? 'move-selector'],
  )
  const autoResolveContext: AutoResolveContext = {
    playerColor,
    initialFen: startFen,
    userElo: MEASURED_USER_ELO,
  }
  const goalOutcome = puzzle.goal === 'win' ? 'win' : 'draw'

  const plies: PlayoutPly[] = []
  const playedMoves: string[] = []
  const defenderMoveTimesMs: number[] = []
  const defenderTablebaseLookups: number[] = []

  // Positions consulted while choosing the move currently being chosen. A set, because the
  // harness pre-warms the cache with the very position the selector then queries itself, and
  // that is one position the defender knew about rather than two.
  const positionsLookedUpForThisMove = new Set<string>()
  const stopListening = tablebase.addLookupListener((positionKey) =>
    positionsLookedUpForThisMove.add(positionKey),
  )

  const finish = (endReason: PlayoutEndReason): PlayoutResult => {
    stopListening()
    return {
      endReason,
      plies,
      finalFen: chess.fen(),
      defenderMoveTimesMs,
      defenderTablebaseLookups,
    }
  }

  /**
   * useMoveSelector prints its candidate table on every move. That is the point of it in
   * the browser devtools, but a full run makes thousands of moves and the tables bury
   * the run's own output. Only `console.log` is swapped, and only for the selector's call,
   * so its warnings and the tablebase's rate-limit notices still come through. The harness
   * already swaps Math.random around a playout the same way.
   *
   * It also keeps terminal I/O out of the move timings, which are meant to measure the work
   * the defender does, not how fast the console can scroll.
   */
  const withoutCandidateLogging = async (
    chooseMove: () => Promise<MoveSelectionResult>,
  ): Promise<MoveSelectionResult> => {
    const originalLog = console.log
    console.log = () => {}
    try {
      return await chooseMove()
    } finally {
      console.log = originalLog
    }
  }

  const timedSelection = async (
    chooseMove: () => Promise<MoveSelectionResult>,
  ): Promise<MoveSelectionResult> => {
    const startedAt = performance.now()
    const selection = await withoutCandidateLogging(chooseMove)
    defenderMoveTimesMs.push(performance.now() - startedAt)
    return selection
  }

  const applyMove = (uci: string, ply: Omit<PlayoutPly, 'san'>): void => {
    const move = chess.move(uciToMoveArgs(uci))
    playedMoves.push(uci)
    plies.push({ ...ply, san: move.san })
  }

  /**
   * The bare engine's move, in the shape the board's auto-solves read.
   *
   * It is searched from the puzzle's starting position with the whole game replayed onto it,
   * exactly as the user engine is: a bare `position fen` leaves the engine blind to what has
   * been played, and in a position where several moves score the same nothing then stops it
   * shuffling into a threefold it cannot see coming. `useMoveSelector` does its own repetition
   * bookkeeping (`seenPositionKeys`) and so never needed this; a plain search must be told.
   */
  const engineBestMove = async (): Promise<MoveSelectionResult> => {
    const [line] = await defenderEngine.getBestMoves(
      startFen,
      [...playedMoves],
      ENGINE_BEST_MOVE_THINKING_TIME_MS,
      1,
    )
    return {
      bestmove: line?.moves[0] ?? null,
      scoreCP: line?.scoreCP ?? null,
      scoreMate: line?.scoreMate ?? null,
      tbData: null,
      selectedLine: line ?? null,
    }
  }

  const selectorMove = async (currentFen: string): Promise<MoveSelectionResult> => {
    // useMoveSelector never awaits its own tablebase query — it only uses the answer if it
    // arrives before the engine search finishes. Warming the cache first is what makes the
    // rate-limited lookup win that race, so the measured defender is the one users face.
    // `offline` skips the warm-up: there is no answer to warm, and awaiting a lookup
    // that fails by design would end the playout instead of leaving the selector to cope
    // without one, which is the whole point of that arm. It still passes `queryTablebase`, so
    // the selector makes (and loses) the request exactly as it does in an offline browser.
    const queryTablebase = countPieces(currentFen) <= TABLEBASE_MAX_PIECES
    if (queryTablebase && options.defenderKind !== 'offline') {
      await tablebase.lookup(currentFen)
    }

    return timedSelection(() =>
      moveSelector.getBestMove(startFen, playedMoves, currentFen, {
        temperature: DEFENDER_TEMPERATURE,
        isPremove: false,
        playerColor,
        queryTablebase,
      }),
    )
  }

  const chooseDefenderMove = async (currentFen: string): Promise<MoveSelectionResult> => {
    positionsLookedUpForThisMove.clear()
    // The bare engine consults no tablebase at all — that is most of what it is missing — so
    // its lookup counts come out at zero, which is the honest reading rather than a gap
    const selection =
      options.defenderKind === 'engine-best-move'
        ? await timedSelection(engineBestMove)
        : await selectorMove(currentFen)
    defenderTablebaseLookups.push(positionsLookedUpForThisMove.size)
    return selection
  }

  // Whether a move by the user would land in a position the board resolves on its own
  const userMoveAutoResolution = (fen: string, line: EngineLine): PlayoutEndReason | null => {
    const first = line.moves[0]
    if (first === undefined) return null
    const probe = new Chess(fen)
    try {
      probe.move(uciToMoveArgs(first))
    } catch {
      return null
    }
    const fenAfter = probe.fen()
    const selection = asDefenderSelection(line)
    if (
      isAutoWin(
        fenAfter,
        puzzle.goal,
        selection.scoreCP,
        selection.scoreMate,
        null,
        autoResolveContext,
      )
    ) {
      return 'auto-win'
    }
    return isAutoDraw(fenAfter, puzzle.goal, selection, autoResolveContext) ? 'auto-draw' : null
  }

  while (plies.length < MAX_PLIES) {
    const terminal = terminalEndReason(chess)
    if (terminal) return finish(terminal)

    const currentFen = chess.fen()
    const isUserToMove = toColor(chess.turn()) === playerColor

    if (isUserToMove) {
      // Both searches are given the game from `startFen` rather than just the current
      // position: a bare `position fen` leaves the engine blind to what has already been
      // played, and in a tablebase win every winning move scores the same, so nothing stops
      // it from shuffling between two of them into a threefold it cannot see coming. The
      // defender does its own repetition bookkeeping (useMoveSelector's seenPositionKeys)
      // and so never needed this; the user engine has no such logic and must be told.
      //
      // One wide search does double duty: it measures how easy this position is to go
      // wrong in, and it enumerates the user's options well enough to spot a move that
      // would end the puzzle on the spot
      const candidateLines = await strongEngine.getBestMoves(
        startFen,
        [...playedMoves],
        TRICKINESS_THINKING_TIME_MS,
        TRICKINESS_MULTIPV,
      )
      const topLine = candidateLines[0]
      const userOutcome =
        (topLine ? scoreToOutcome(topLine.scoreCP, topLine.scoreMate) : null) ?? goalOutcome
      const trickiness = 1 - engineMaintainFraction(currentFen, candidateLines, userOutcome)

      // The user had a move into a position the board would have resolved for them, so
      // that is where the defense stopped mattering — nothing after it counts
      const autoResolution = candidateLines
        .map((line) => userMoveAutoResolution(currentFen, line))
        .find((reason) => reason !== null)
      if (autoResolution) return finish(autoResolution)

      const [userLine] = await strongEngine.getBestMoves(
        startFen,
        [...playedMoves],
        USER_MOVE_THINKING_TIME_MS,
        1,
      )
      const userMove = userLine?.moves[0]
      if (userMove === undefined) return finish('selector-gave-no-move')
      applyMove(userMove, {
        side: 'user',
        fenBefore: currentFen,
        userMaterialBalance: userMaterialBalance(currentFen, playerColor),
        trickiness,
      })
      continue
    }

    const selection = await chooseDefenderMove(currentFen)
    if (!selection.bestmove) return finish('selector-gave-no-move')

    // Same order the board applies them in (ChessBoard.vue's triggerEngineTurn): both are
    // judged on the position *before* the defender's reply lands
    if (
      isAutoWin(
        currentFen,
        puzzle.goal,
        selection.scoreCP,
        selection.scoreMate,
        selection.tbData?.category ?? null,
        autoResolveContext,
      )
    ) {
      return finish('auto-win')
    }
    if (isAutoDraw(currentFen, puzzle.goal, selection, autoResolveContext)) {
      return finish('auto-draw')
    }

    applyMove(selection.bestmove, {
      side: 'defender',
      fenBefore: currentFen,
      userMaterialBalance: userMaterialBalance(currentFen, playerColor),
      trickiness: null,
    })
  }

  return finish('ply-limit-reached')
}
