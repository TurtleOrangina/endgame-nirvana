import { Chess } from 'chess.js'
import type { EngineLine, PlayerColor } from '@/types'
import {
  DEFAULT_BEST_MOVE_THINKING_TIME_MS,
  type StockfishEngine,
} from '@/composables/useStockfishEngine'
import {
  PRODUCTION_TUNING,
  TEMPERATURE,
  TEMPERATURE_PAWNLESS_FIRST_TRY,
  useMoveSelector,
  type MoveSelectionResult,
  type SelectorTuning,
} from '@/composables/useMoveSelector'
import { isAutoDraw, isAutoWin, type AutoResolveContext } from '@/utils/autoResolve'
import { engineMaintainFraction } from '@/utils/maintainFraction'
import { hasPawnsOnBoard, materialByColor, uciToMoveArgs } from '@/utils/chess'
import { scoreToOutcome } from '@/utils/puzzleEvaluation'
import { MIN_TEMPERATURE } from '@/utils/weightedSample'
import { useLichessTablebase } from '@/composables/useLichessTablebase'
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

// What the Lichess tablebase actually answers in full. The app queries one man beyond it
// (some 8-men positions still resolve), but a defender that plays *straight off* the
// tablebase needs every move classified, so it stops at 7.
const TABLEBASE_MAX_MEN_FOR_LOOKUP = 7

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
}

/**
 * Which opponent is being measured. Everything else about the playout (the user engine,
 * the done detection, the trimming, the trickiness measurement) is identical across all
 * three, so the difference between two runs is the defender and nothing else.
 *
 * - `move-selector` — the app's real one.
 * - `multipv1` — the floor: one 400 ms search, top line played. No tablebase, no delayer,
 *   no trickster, no sampling; what the app would be if `useMoveSelector` didn't exist.
 * - `multipv1-tablebase` — the same, except a won position small enough for the tablebase
 *   is played straight off it (its moves arrive sorted best-first by dtm, or by dtz where
 *   that is the more valuable ordering). This isolates how much of the selector's value is
 *   just having perfect information where perfect information exists.
 * - `no-trickster` — the real selector with the Trickster switched off, so a lost position
 *   is sampled by the delayer alone and a drawn one uniformly. What the Trickster is worth.
 * - `multipv-rank-delayer` — the real selector, but where the delayer has no dtd to work
 *   with it weights the lines by their multipv ordering instead of their centipawn gaps.
 * - `with-variance` — the selector driven at the temperature the *app* uses, so its own
 *   sampling is in the measurement. Everything else runs at MIN_TEMPERATURE; see
 *   `defenderTemperature`.
 * - `trickster-led` — the real selector with the delayer's weight no longer squared, so the
 *   Trickster decides a lost position and the delayer only breaks its ties.
 * - `trickster-geomean` — the Trickster combining a line's probes by geometric mean instead
 *   of by product, so its weight stops depending on how long the line's PV happened to be.
 * - `trickster-focused` — the Trickster probing only the candidates the delayer rates
 *   highest, each for proportionally longer, at the same total search cost. Measured, briefly
 *   adopted, then reverted — see the README. `trickster-unfocused` is the shipped tuning under
 *   another name, used to measure drift.
 */
export type DefenderKind =
  | 'move-selector'
  | 'multipv1'
  | 'multipv1-tablebase'
  | 'no-trickster'
  | 'multipv-rank-delayer'
  | 'with-variance'
  | 'trickster-led'
  | 'trickster-geomean'
  | 'trickster-focused'
  | 'trickster-unfocused'
  | 'zeroing-distance'
  | 'dtm-only-distance'

export const SELECTOR_TUNINGS: Record<DefenderKind, SelectorTuning> = {
  'move-selector': PRODUCTION_TUNING,
  multipv1: PRODUCTION_TUNING,
  'multipv1-tablebase': PRODUCTION_TUNING,
  'no-trickster': { ...PRODUCTION_TUNING, trickster: false },
  'multipv-rank-delayer': { ...PRODUCTION_TUNING, delayerFallback: 'multipv-rank' },
  'with-variance': PRODUCTION_TUNING,
  // Win-goal delay turned out to have almost no headroom — every defender ever measured
  // lands within two moves of a bare multipv-1 search — while the Trickster is worth ~0.08
  // trickiness. This arm turns the dial the other way: the delayer stops being squared, so
  // it only breaks the Trickster's ties instead of overruling it.
  'trickster-led': { ...PRODUCTION_TUNING, delayerExponent: 1 },
  // A line is probed at as many positions as its PV is long enough to supply, and MultiPV
  // PV lengths vary from a couple of half-moves to twenty. Multiplying the fractions makes
  // the longer-PV line look trickier for a reason that is about the search rather than the
  // position; the geometric mean divides that out.
  'trickster-geomean': { ...PRODUCTION_TUNING, tricksterAggregation: 'geometric-mean' },
  'trickster-focused': { ...PRODUCTION_TUNING, tricksterProbedCandidates: 3 },
  // Identical to what ships. It exists to measure the *measurement*: running the shipped
  // tuning against its own committed baseline reports the run-to-run drift that every other
  // comparison is read on top of. It is not a design alternative.
  'trickster-unfocused': PRODUCTION_TUNING,
  // The two arms of the zeroing-distance question. They are deliberately a pair rather than
  // one kind measured against `move-selector`'s baseline: the effect only shows in positions
  // where a zeroing move is as decisive as mate, which is a small enough slice of a full run
  // that it has to be measured on a targeted puzzle set — and a run on a different puzzle set
  // is not comparable to the shipped baseline.
  'zeroing-distance': PRODUCTION_TUNING,
  'dtm-only-distance': { ...PRODUCTION_TUNING, zeroingDistance: false },
}

/**
 * The temperature the measurement drives the selector at.
 *
 * Evaluation runs at `MIN_TEMPERATURE` by default: the selector then always plays its
 * highest-weighted candidate, and still samples between candidates the weighting rates
 * exactly equal. That is deliberately *not* how the app behaves — the variance the app's
 * temperature buys is what keeps a puzzle worth replaying — but a comparison is trying to
 * find out which weighting defends better, and letting each run roll its own dice only adds
 * a noise source on top of the two time-limited engines. The sampling is a property of the
 * opponent rather than of the weighting, so it is held fixed unless it is the thing under
 * test.
 *
 * `with-variance` is that exception: the shipped temperature, sampling included, which is
 * what says whether the variance itself costs anything.
 */
function defenderTemperature(defenderKind: DefenderKind, currentFen: string): number {
  if (defenderKind !== 'with-variance') return MIN_TEMPERATURE
  return hasPawnsOnBoard(currentFen) ? TEMPERATURE : TEMPERATURE_PAWNLESS_FIRST_TRY
}

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
  // Reads through the same intercepted fetch and disk cache as the harness's own client
  const lichessTablebase = useLichessTablebase()
  const autoResolveContext: AutoResolveContext = {
    playerColor,
    initialFen: startFen,
    userElo: MEASURED_USER_ELO,
  }
  const goalOutcome = puzzle.goal === 'win' ? 'win' : 'draw'

  const plies: PlayoutPly[] = []
  const playedMoves: string[] = []
  const defenderMoveTimesMs: number[] = []
  const finish = (endReason: PlayoutEndReason): PlayoutResult => ({
    endReason,
    plies,
    finalFen: chess.fen(),
    defenderMoveTimesMs,
  })

  /**
   * useMoveSelector prints its candidate table on every move. That is the point of it in
   * the browser devtools, but a 120-puzzle run makes thousands of moves and the tables bury
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

  // The move the opponent under measurement plays, in the shape the board's auto-solves
  // read. The plain-engine defender gets the same 400 ms budget useMoveSelector's own
  // bestmove search uses, so the two differ in what they do with the search, not in how
  // much thinking they are given.
  const plainEngineMove = async (currentFen: string): Promise<MoveSelectionResult> => {
    const [line] = await defenderEngine.getBestMoves(
      currentFen,
      [],
      DEFAULT_BEST_MOVE_THINKING_TIME_MS,
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

  const chooseDefenderMove = async (currentFen: string): Promise<MoveSelectionResult> => {
    if (options.defenderKind === 'multipv1') {
      return timedSelection(() => plainEngineMove(currentFen))
    }

    if (options.defenderKind === 'multipv1-tablebase') {
      // Only a won puzzle inside the tablebase's reach: a drawn one has no distance to
      // maximize, and the ordering that makes this defender interesting is the dtm one.
      const isTablebaseWin =
        puzzle.goal === 'win' && countPieces(currentFen) <= TABLEBASE_MAX_MEN_FOR_LOOKUP
      if (isTablebaseWin) {
        const result = await lichessTablebase.query(currentFen)
        const topMove = result?.moves[0]
        // The scores stay null: the tablebase category is a stronger verdict than an
        // engine evaluation, and evaluatePuzzleGoal prefers it wherever it settles the goal
        if (topMove) {
          // A move read off the tablebase costs no thinking; the query that produced it is
          // network time, which the move times deliberately don't count
          defenderMoveTimesMs.push(0)
          return {
            bestmove: topMove.uci,
            scoreCP: null,
            scoreMate: null,
            tbData: result,
            selectedLine: null,
          }
        }
      }
      return timedSelection(() => plainEngineMove(currentFen))
    }

    // useMoveSelector never awaits its own tablebase query — it only uses the answer if it
    // arrives before the engine search finishes. Warming the cache first is what makes the
    // rate-limited lookup win that race, so the measured defender is the one users face.
    const queryTablebase = countPieces(currentFen) <= TABLEBASE_MAX_PIECES
    if (queryTablebase) await tablebase.lookup(currentFen)

    return timedSelection(() =>
      moveSelector.getBestMove(startFen, playedMoves, currentFen, {
        temperature: defenderTemperature(options.defenderKind ?? 'move-selector', currentFen),
        isPremove: false,
        playerColor,
        queryTablebase,
      }),
    )
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
