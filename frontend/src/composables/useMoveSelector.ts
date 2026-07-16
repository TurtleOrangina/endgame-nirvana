import { watch } from 'vue'
import { Chess } from 'chess.js'
import type {
  EngineLine,
  EngineLineWithDTD,
  GameResult,
  PlayerColor,
  TablebaseResult,
} from '@/types'
import {
  FAILURE_RECHECK_THINKING_TIME_MS,
  PREMOVE_THINKING_TIME_MS,
  PROBE_THINKING_TIME_MS,
  useStockfishEngine,
} from '@/composables/useStockfishEngine'
import { useLichessTablebase, type OutcomeRetainingResult } from '@/composables/useLichessTablebase'
import { scoreToOutcome } from '@/utils/puzzleEvaluation'
import { EPSILON, weightedSample } from '@/utils/weightedSample'
import {
  hasPawnsOnBoard,
  isBareKingVsMajorPiece,
  isSymmetricMajorPieceEndgame,
  MIN_ELO_MAJOR_PIECE_VS_KING_IS_WON,
  uciToMoveArgs,
} from '@/utils/chess'

const BESTMOVE_MULTIPV = 5
// How many of the user's upcoming positions per line are probed for the Trickster pattern
const LINE_PROBING = 5
const PROBE_MULTIPV = 64
const SELECTION_TIMEOUT_MS = 15_000
// Stands in for |scoreCP| when a line only has a mate score, so it sorts as "hopeless"
const MATE_ONLY_FALLBACK_CP = 10_000
// How strongly the delayer gates the trickster when their weights are multiplied together
const DELAYER_EXPONENT = 2
// Halfmoves without a pawn move or capture before the engine starts favoring zeroing
// moves in drawn positions, instead of milking the full 50-move rule (e.g. shuffling for
// 49 moves between each pawn push in a wrong-bishop fortress)
const STALLED_HALFMOVE_CLOCK = 24

export interface MoveSelectionOptions {
  temperature: number
  isPremove: boolean
  playerColor: PlayerColor
  queryTablebase: boolean
  userElo: number
  // Checked between the serialized probe searches so a stale selection stops burning engine time
  shouldAbort?: () => boolean
}

export interface MoveSelectionResult {
  bestmove: string | null
  // Evaluation of the position itself (the multipv-1 line), not of the sampled move —
  // feeds puzzle failure detection and auto-solve exactly like the old single-PV search
  scoreCP: number | null
  scoreMate: number | null
  tbData: TablebaseResult | null
}

export function useMoveSelector() {
  const engine = useStockfishEngine()
  const tablebase = useLichessTablebase()

  // Safety net: if the engine hangs (e.g. worker crash), resolve with null after a
  // generous timeout so the board never freezes permanently. The clock only starts once
  // the engine is actually ready — it can otherwise still be downloading its WASM
  // binary, which legitimately takes far longer on a slow connection and isn't a hang.
  function createSafetyTimeout(): Promise<null> {
    return new Promise<null>((resolve) => {
      const startTimer = (): void => {
        setTimeout(() => resolve(null), SELECTION_TIMEOUT_MS)
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
  }

  // Fraction of the user's legal moves that keep the outcome best play would achieve,
  // estimated from a wide (MultiPV 64) shallow engine search. With so few pieces on the
  // board this covers essentially every legal move. When the user is winning, only moves
  // that keep the win maintain — e.g. blundering into stalemate drops it; when drawing,
  // anything that isn't lost does.
  function engineMaintainFraction(
    lines: EngineLine[],
    userOutcomeWithBestPlay: GameResult,
  ): number {
    if (lines.length === 0) return 1
    const maintaining = lines.filter((l) => {
      const outcome = scoreToOutcome(l.scoreCP, l.scoreMate)
      return userOutcomeWithBestPlay === 'win' ? outcome === 'win' : outcome !== 'loss'
    }).length
    return Math.max(0.35, maintaining / lines.length)
  }

  // Positions along the line where the user is to move — these are what the user would
  // actually face if the computer picks this line's first move.
  function collectUserToMovePositions(line: EngineLine, currentFen: string): string[] {
    const chess = new Chess(currentFen)
    const positions: string[] = []
    for (let i = 0; i < line.moves.length && positions.length < LINE_PROBING; i++) {
      try {
        chess.move(uciToMoveArgs(line.moves[i]!))
      } catch {
        break
      }
      if (chess.isGameOver()) break
      const isComputerMove = i % 2 === 0
      if (isComputerMove) positions.push(chess.fen())
    }
    return positions
  }

  // A capture by the user that lands directly in a done position — the line itself may
  // never play it (a mating line happily ignores a hanging piece), but the user would.
  function userCanCaptureIntoDone(
    chess: Chess,
    isDonePosition: (chess: Chess) => boolean,
  ): boolean {
    return chess.moves({ verbose: true }).some((move) => {
      if (!move.isCapture() && !move.isEnPassant()) return false
      chess.move(move)
      const done = isDonePosition(chess) && !chess.isStalemate()
      chess.undo()
      return done
    })
  }

  // A move that resets the halfmove clock (pawn move or capture) — in a stalled drawn
  // position these are the only moves that make progress toward ending the game
  function isZeroingMove(fen: string, uci: string): boolean {
    try {
      const move = new Chess(fen).move(uciToMoveArgs(uci))
      return move.piece === 'p' || move.isCapture() || move.isEnPassant()
    } catch {
      return false
    }
  }

  // Engine-only fallback for the stalled-draw injection below: check each legal zeroing
  // move with a short single-line search and return the first one that keeps the
  // position drawn. Slower and less reliable than the tablebase, hence only a fallback.
  async function findDrawRetainingZeroingMove(
    currentFen: string,
    shouldAbort: (() => boolean) | undefined,
  ): Promise<string | null> {
    const legalZeroingMoves = new Chess(currentFen)
      .moves({ verbose: true })
      .filter((move) => move.piece === 'p' || move.isCapture() || move.isEnPassant())
    for (const move of legalZeroingMoves) {
      if (shouldAbort?.()) return null
      const lines = await engine
        .getBestMoves(move.after, [], FAILURE_RECHECK_THINKING_TIME_MS, 1)
        .catch((): EngineLine[] => [])
      const replyLine = lines[0]
      if (replyLine && scoreToOutcome(replyLine.scoreCP, replyLine.scoreMate) === 'draw') {
        return move.from + move.to + (move.promotion ?? '')
      }
    }
    return null
  }

  function computeDistanceToDone(
    line: EngineLine,
    currentFen: string,
    tbOutcome: OutcomeRetainingResult | null,
    outcomeWithBestUserPlay: GameResult,
    playerColor: PlayerColor,
    userElo: number,
  ): number | null {
    let dtd: number | null = null

    // Seed from the tablebase's distance to mate (dtm is in half-moves from the position
    // after the move, so the move itself adds one). Drawn moves report dtm 0 — there is
    // no mate distance, so they must not seed anything.
    const tbMove = tbOutcome?.result.moves.find((m) => m.uci === line.moves[0])
    if (tbMove && tbMove.dtm !== null && tbMove.dtm !== 0) dtd = Math.abs(tbMove.dtm) + 1

    // Engine mate scores are in full moves
    if (dtd === null && line.scoreMate !== null) dtd = 2 * Math.abs(line.scoreMate)

    const isDonePosition = (chess: Chess): boolean => {
      const fen = chess.fen()
      return (
        (userElo > MIN_ELO_MAJOR_PIECE_VS_KING_IS_WON &&
          isBareKingVsMajorPiece(fen, playerColor)) ||
        chess.isInsufficientMaterial() ||
        (outcomeWithBestUserPlay === 'draw' && isSymmetricMajorPieceEndgame(fen))
      )
    }

    // Play the line out and stop at the first position the user would call "done" — e.g.
    // winning the defender's last piece makes checkmating with the queen a formality
    const chess = new Chess(currentFen)
    for (let i = 0; i < line.moves.length; i++) {
      try {
        chess.move(uciToMoveArgs(line.moves[i]!))
      } catch {
        break
      }
      const halfMovesPlayed = i + 1
      if (isDonePosition(chess)) {
        dtd = Math.min(dtd ?? Infinity, halfMovesPlayed)
        break
      }
      // The line tracks the fastest mate, which can leave a blundered piece hanging
      // forever (capturing it would only slow the mate down) — but the user would just
      // take it and call the position done, so probe their one-move deviations too
      const isUserToMove = i % 2 === 0
      if (isUserToMove && userCanCaptureIntoDone(chess, isDonePosition)) {
        dtd = Math.min(dtd ?? Infinity, halfMovesPlayed + 1)
        break
      }
    }

    return dtd
  }

  // Normalize to sum 1, then — unless everything is already near-uniformly spread — zero
  // out near-zero weights and renormalize, so even a tiny chance of playing the very
  // obvious blunders (mate in 1, hanging a piece) is eliminated.
  function normalizeWeights(rawWeights: number[]): number[] {
    const total = rawWeights.reduce((sum, w) => sum + w, 0)
    const normalized = rawWeights.map((w) => w / total)
    if (Math.max(...normalized) <= 0.05) return normalized
    const pruned = normalized.map((w) => (w < 0.01 ? 0 : w))
    const prunedTotal = pruned.reduce((sum, w) => sum + w, 0)
    return pruned.map((w) => w / prunedTotal)
  }

  // The delayer weight acts as a prior (counted double, so a move it rates poorly stays
  // low no matter how tricky) and the trickster as a likelihood update — when the delayer
  // is near-uniform its factor is near-constant and the trickster decides the ordering.
  function combineDelayerAndTrickster(delayer: number[], trickster: number[]): number[] {
    const products = delayer.map((weight, i) => weight ** DELAYER_EXPONENT * trickster[i]!)
    if (products.every((product) => product === 0)) return delayer
    return normalizeWeights(products)
  }

  // Maximize the distance to done so the user has to actually
  // convert. Exponential at the start (trivial distances get almost no weight), softening
  // to quadratic once the path is long enough that the user can't calculate to the end
  // anyway — a mate in 14 shouldn't practically never appear next to a mate in 18.
  function getSamplingWeightsDelayer(candidates: EngineLineWithDTD[]): number[] {
    if (candidates.every((c) => c.dtd !== null)) {
      return normalizeWeights(
        candidates.map((c) => (c.dtd! < 7 ? 2 ** c.dtd! : 2 ** 6 + c.dtd! ** 2)),
      )
    }
    // No dtd for every line — the engine wants to minimize |scoreCP| when losing
    return normalizeWeights(
      candidates.map((c) => {
        const absoluteCp = c.scoreCP !== null ? Math.abs(c.scoreCP) : MATE_ONLY_FALLBACK_CP
        return 1 / Math.max(1, absoluteCp)
      }),
    )
  }

  // Weight each line by how easy it would be for the user to drop the ball along it. For
  // every probed user-to-move position we estimate the fraction of moves that hold the
  // best outcome; the product over the line approximates the chance a careless user
  // survives it, and rare survival means high training value.
  async function getSamplingWeightsTrickster(
    candidates: EngineLineWithDTD[],
    currentFen: string,
    outcomeWithBestUserPlay: GameResult,
    shouldAbort: (() => boolean) | undefined,
  ): Promise<{ weights: number[]; lineProducts: number[] }> {
    // outcomeWithBestUserPlay is from the computer's perspective; the probed positions
    // are user-to-move, so flip it to know what the user has to maintain there
    const userOutcomeWithBestPlay: GameResult =
      outcomeWithBestUserPlay === 'loss'
        ? 'win'
        : outcomeWithBestUserPlay === 'win'
          ? 'loss'
          : 'draw'
    interface Probe {
      lineIndex: number
      fen: string
    }

    const probes: Probe[] = candidates.flatMap((line, lineIndex) =>
      collectUserToMovePositions(line, currentFen).map((fen) => ({ lineIndex, fen })),
    )

    // Engine probes run strictly one after another: the shared worker only supports a
    // single search, and Stockfish already saturates multiple cores on its own
    const lineProducts = candidates.map(() => 1)
    for (const probe of probes) {
      if (shouldAbort?.()) {
        return { weights: normalizeWeights(candidates.map(() => 1)), lineProducts }
      }

      const fraction = await engine
        .getBestMoves(probe.fen, [], PROBE_THINKING_TIME_MS, PROBE_MULTIPV)
        .then((lines) => engineMaintainFraction(lines, userOutcomeWithBestPlay))
      lineProducts[probe.lineIndex] = lineProducts[probe.lineIndex]! * fraction
    }

    const weights = normalizeWeights(
      lineProducts.map((product) => 1 / Math.min(1, Math.max(EPSILON, product))),
    )
    return { weights, lineProducts }
  }

  async function getBestMove(
    startFen: string,
    moves: string[],
    currentFen: string,
    options: MoveSelectionOptions,
  ): Promise<MoveSelectionResult> {
    // Kicked off alongside the engine but never awaited: the tablebase only participates
    // if its answer has arrived by the time the engine is done
    const tbState: { outcome: OutcomeRetainingResult | null } = { outcome: null }
    if (options.queryTablebase) {
      tablebase
        .queryOutcomeRetaining(currentFen)
        .then((outcome) => {
          tbState.outcome = outcome
        })
        .catch(() => {
          // Tablebase failed — selection proceeds engine-only
        })
    }

    const enginePromise = engine
      .getBestMoves(
        startFen,
        moves,
        options.isPremove ? PREMOVE_THINKING_TIME_MS : undefined,
        options.isPremove ? 1 : BESTMOVE_MULTIPV,
      )
      .catch((): EngineLine[] => [])

    const lines = await Promise.race([enginePromise, createSafetyTimeout()])
    const tbOutcome = tbState.outcome
    const tbData = tbOutcome?.result ?? null
    if (lines === null || lines.length === 0 || lines[0]!.moves.length === 0) {
      return { bestmove: null, scoreCP: null, scoreMate: null, tbData }
    }

    const scoreCP = lines[0]!.scoreCP
    const scoreMate = lines[0]!.scoreMate

    if (options.isPremove) {
      const engineMove = lines[0]!.moves[0]!
      const retainedMove = tbOutcome?.outcomeRetainingMoves[0]?.uci
      if (
        tbOutcome &&
        retainedMove &&
        !tbOutcome.outcomeRetainingMoves.some((m) => m.uci === engineMove)
      ) {
        console.warn(
          `Premove reply ${engineMove} does not retain the outcome per tablebase, playing ${retainedMove} instead`,
        )
        return { bestmove: retainedMove, scoreCP, scoreMate, tbData }
      }
      return { bestmove: engineMove, scoreCP, scoreMate, tbData }
    }

    // Filter the engine lines down to moves that keep the best achievable outcome —
    // authoritatively via tablebase when available, otherwise by the engine's own scores
    let outcomeWithBestUserPlay: GameResult
    let candidates: EngineLine[]
    if (tbOutcome) {
      outcomeWithBestUserPlay = tbOutcome.bestOutcome
      const retainingUcis = new Set(tbOutcome.outcomeRetainingMoves.map((m) => m.uci))
      candidates = lines.filter((l) => retainingUcis.has(l.moves[0]!))
      if (candidates.length === 0) {
        const fallback = tbOutcome.outcomeRetainingMoves[0]?.uci ?? null
        console.warn(
          'Engine suggested no outcome-retaining moves, playing the top tablebase move',
          fallback,
        )
        return { bestmove: fallback, scoreCP, scoreMate, tbData }
      }
    } else {
      const engineOutcome = scoreToOutcome(scoreCP, scoreMate)
      if (engineOutcome === null) {
        return { bestmove: lines[0]!.moves[0]!, scoreCP, scoreMate, tbData }
      }
      outcomeWithBestUserPlay = engineOutcome
      candidates = lines.filter((l) => scoreToOutcome(l.scoreCP, l.scoreMate) === engineOutcome)
    }

    const halfmoveClock = Number(currentFen.split(' ')[4]) || 0
    const isStalledDraw =
      outcomeWithBestUserPlay === 'draw' && halfmoveClock >= STALLED_HALFMOVE_CLOCK

    // A zeroing move rarely shows up among the engine's top lines (every drawn move
    // scores alike), so pull one in when the engine offered none: tablebase-verified when
    // available, otherwise engine-verified. A tablebase that lists no zeroing move among
    // the outcome-retaining ones is authoritative (every pawn push or capture would lose
    // the draw) — the engine fallback must not second-guess it.
    if (isStalledDraw && !candidates.some((line) => isZeroingMove(currentFen, line.moves[0]!))) {
      const zeroingUci = tbOutcome
        ? (tbOutcome.outcomeRetainingMoves.find((m) => m.zeroing)?.uci ?? null)
        : await findDrawRetainingZeroingMove(currentFen, options.shouldAbort)
      if (zeroingUci) {
        candidates = [
          ...candidates,
          {
            moves: [zeroingUci],
            scoreCP: 0,
            scoreMate: null,
            depth: 0,
            multipvIndex: candidates.length + 1,
          },
        ]
      }
    }

    // A won position is converted mercilessly with the strongest line — playing out a
    // lost position isn't training for the user
    if (candidates.length === 1 || outcomeWithBestUserPlay === 'win') {
      return { bestmove: candidates[0]!.moves[0]!, scoreCP, scoreMate, tbData }
    }

    const candidatesWithDtd: EngineLineWithDTD[] = candidates.map((line) => ({
      ...line,
      dtd: computeDistanceToDone(
        line,
        currentFen,
        tbOutcome,
        outcomeWithBestUserPlay,
        options.playerColor,
        options.userElo,
      ),
    }))

    const uciToSan = (uci: string): string => {
      try {
        return new Chess(currentFen).move(uciToMoveArgs(uci)).san
      } catch {
        return uci
      }
    }
    const asPercent = (value: number): string => `${(value * 100).toFixed(1)}%`.padStart(5)

    let weights: number[]
    if (outcomeWithBestUserPlay === 'draw') {
      const trickster = await getSamplingWeightsTrickster(
        candidatesWithDtd,
        currentFen,
        outcomeWithBestUserPlay,
        options.shouldAbort,
      )
      weights = trickster.weights
      const zeroingFlags = candidatesWithDtd.map((c) => isZeroingMove(currentFen, c.moves[0]!))
      let zeroingBoost = 1
      if (isStalledDraw) {
        // Doubles every 2 halfmoves past the threshold — gentle at first, then
        // irresistible, so the game keeps progressing no matter how tricky the shuffles
        zeroingBoost = 2 ** ((halfmoveClock - STALLED_HALFMOVE_CLOCK) / 2 + 3)
        weights = normalizeWeights(
          weights.map((w, i) => (zeroingFlags[i] ? Math.max(w, 0.01) * zeroingBoost : w)),
        )
      }
      console.log(
        `Move candidates (${outcomeWithBestUserPlay}, halfmove clock ${halfmoveClock}) ${currentFen}:\n`,
      )
      const byWeightDescending = [...candidatesWithDtd.keys()].sort(
        (a, b) => weights[b]! - weights[a]!,
      )
      for (const i of byWeightDescending) {
        const c = candidatesWithDtd[i]!
        console.log(
          `    ${uciToSan(c.moves[0]!)}  w=${asPercent(weights[i]!)} ` +
            `(dtd=${c.dtd ?? '?'}, fault_potential=${asPercent(1 - trickster.lineProducts[i]!)})` +
            (zeroingFlags[i] ? ` zeroing_boost=x${zeroingBoost.toFixed(0)}` : '') +
            '\n',
        )
      }
    } else {
      const delayerWeights = getSamplingWeightsDelayer(candidatesWithDtd)
      // In a pawnless lost position the trickster adds nothing but noise — pure piece
      // play offers no structural traps worth steering into, so the delayer decides alone
      const trickster = hasPawnsOnBoard(currentFen)
        ? await getSamplingWeightsTrickster(
            candidatesWithDtd,
            currentFen,
            outcomeWithBestUserPlay,
            options.shouldAbort,
          )
        : null
      weights = trickster
        ? combineDelayerAndTrickster(delayerWeights, trickster.weights)
        : delayerWeights
      console.log(`Move candidates (${outcomeWithBestUserPlay}) ${currentFen}:\n`)
      const byCombinedWeightDescending = [...candidatesWithDtd.keys()].sort(
        (a, b) => weights[b]! - weights[a]!,
      )
      for (const i of byCombinedWeightDescending) {
        const c = candidatesWithDtd[i]!
        const move = uciToSan(c.moves[0]!).padStart(5)
        const dtd = String(c.dtd ?? '?').padStart(2)
        const fault = trickster ? asPercent(1 - trickster.lineProducts[i]!) : '  n/a'
        const wDelayer = asPercent(delayerWeights[i]!)
        const wTrickster = trickster ? asPercent(trickster.weights[i]!) : '  n/a'

        console.log(
          `    ${move} w=${asPercent(weights[i]!)} w_delayer=${wDelayer} w_trickster=${wTrickster} ` +
            `(dtd=${dtd} fault_potential=${fault})`,
        )
      }
    }

    const chosen = weightedSample(
      candidatesWithDtd,
      weights,
      options.temperature,
      (c) => c.moves[0]!,
    )
    return { bestmove: chosen.moves[0]!, scoreCP, scoreMate, tbData }
  }

  return { getBestMove }
}
