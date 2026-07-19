import { watch } from 'vue'
import { Chess, type Move } from 'chess.js'
import type {
  DtdReason,
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
  materialByColor,
  uciToMoveArgs,
} from '@/utils/chess'

const BESTMOVE_MULTIPV = 5
// How many of the user's upcoming positions per line are probed for the Trickster pattern
const LINE_PROBING = 5
const PROBE_MULTIPV = 64
const SELECTION_TIMEOUT_MS = 15_000
// Stands in for |scoreCP| when a line only has a mate score, so it sorts as "hopeless"
const MATE_ONLY_FALLBACK_CP = 10_000
// In the delayer's cp fallback, how many centipawns worse than the least-bad candidate
// halves a move's weight — the resistance signal lives in the score gaps between
// candidates, not in the (uniformly huge) absolute evaluations
const CP_FALLBACK_HALVING_GAP = 100
// How strongly the delayer gates the trickster when their weights are multiplied together
const DELAYER_EXPONENT = 2
// Halfmoves without a pawn move or capture before the engine starts favoring zeroing
// moves in drawn positions, instead of milking the full 50-move rule (e.g. shuffling for
// 49 moves between each pawn push in a wrong-bishop fortress)
const STALLED_HALFMOVE_CLOCK = 24
// How far into a line the material balance is scanned for a stable level, and how many
// consecutive half-moves must hold it to count as stable
const STABLE_BALANCE_SCAN_HALFMOVES = 8
const STABLE_BALANCE_RUN_HALFMOVES = 3
// Falling this many pawns of material below the top line's stable balance, sustained over
// the deficit window, makes a position "done" — the deficit incurred is too high to matter
const DONE_MATERIAL_DEFICIT = 2
// Halfmoves the deficit must hold; a line that ends inside the window still counts as
// done when at least one of its remaining positions shows the deficit (the engine's PV
// is often too short to hold a late promotion for the full window)
const DEFICIT_WINDOW_LENGTH = 4
// Weight of a non-maintaining move whose engine refutation is an immediate checkmate or
// an immediate capture no maintaining line allows — a blunder that obvious barely dilutes
// the position's trickiness, since even a careless user would spot the refutation
const OBVIOUS_BLUNDER_WEIGHT = 0.1

export interface MoveSelectionOptions {
  temperature: number
  isPremove: boolean
  playerColor: PlayerColor
  queryTablebase: boolean
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

function uciToSan(fen: string, uci: string): string {
  try {
    return new Chess(fen).move(uciToMoveArgs(uci)).san
  } catch {
    return uci
  }
}

function asPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`.padStart(6)
}

function dtdWithReason(candidate: EngineLineWithDTD): string {
  return `dtd=${candidate.dtd ?? '?'}${candidate.dtdReason ? ` [${candidate.dtdReason}]` : ''}`
}

// How a set of candidates should be sampled, plus what to log about each one
interface CandidateSamplingPlan {
  header: string
  weights: number[]
  describeCandidate: (index: number) => string
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

  // Weighted fraction of the user's legal moves that keep the outcome best play would
  // achieve, estimated from a wide (MultiPV 64) shallow engine search. With so few pieces
  // on the board this covers essentially every legal move. When the user is winning, only
  // moves that keep the win maintain — e.g. blundering into stalemate drops it; when
  // drawing, anything that isn't lost does. Moves are weighted by how likely the user is
  // to consider them: non-maintaining moves refuted by an obvious reply count far less,
  // while maintaining moves that are checks or captures count more — the fewer legal
  // checks/captures there are to sift through, the easier the move is to spot.
  function engineMaintainFraction(
    probedFen: string,
    lines: EngineLine[],
    userOutcomeWithBestPlay: GameResult,
  ): number {
    if (lines.length === 0) return 1
    const maintainsOutcome = (line: EngineLine): boolean => {
      const outcome = scoreToOutcome(line.scoreCP, line.scoreMate)
      return userOutcomeWithBestPlay === 'win' ? outcome === 'win' : outcome !== 'loss'
    }

    const isCheck = (move: Move): boolean => move.san.includes('+') || move.san.includes('#')
    const isCapture = (move: Move): boolean => move.isCapture() || move.isEnPassant()
    const legalMoves = new Chess(probedFen).moves({ verbose: true })
    const legalCheckCount = legalMoves.filter(isCheck).length
    const legalCaptureCount = legalMoves.filter(isCapture).length
    const maintainingLineResponses = new Set(
      lines
        .filter(maintainsOutcome)
        .flatMap((line) => (line.moves[1] !== undefined ? [line.moves[1]] : [])),
    )

    // Checks and captures are what the user calculates first, so a maintaining one is
    // easier to find than a quiet move — the more so the fewer there are to sift through
    const maintainingMoveWeight = (uci: string): number => {
      const move = legalMoves.find((m) => m.from + m.to + (m.promotion ?? '') === uci)
      if (!move) return 1
      let weight = 1
      if (isCheck(move)) weight = Math.max(weight, 1 + 1 / legalCheckCount)
      if (isCapture(move)) weight = Math.max(weight, 1 + 1 / legalCaptureCount)
      return weight
    }

    // A faulty move refuted by an immediate mate, or by an immediate capture that no
    // maintaining line concedes anyway, is a one-move blunder the user would hardly play
    const faultyMoveWeight = (line: EngineLine): number => {
      const responseUci = line.moves[1]
      if (responseUci === undefined) return 1
      const chess = new Chess(probedFen)
      let response: Move
      try {
        chess.move(uciToMoveArgs(line.moves[0]!))
        response = chess.move(uciToMoveArgs(responseUci))
      } catch {
        return 1
      }
      const isMateBlunder = chess.isCheckmate()
      const isMaterialBlunder = isCapture(response) && !maintainingLineResponses.has(responseUci)
      return isMateBlunder || isMaterialBlunder ? OBVIOUS_BLUNDER_WEIGHT : 1
    }

    let maintainingWeight = 0
    let totalWeight = 0
    for (const line of lines) {
      const weight = maintainsOutcome(line)
        ? maintainingMoveWeight(line.moves[0]!)
        : faultyMoveWeight(line)
      if (maintainsOutcome(line)) maintainingWeight += weight
      totalWeight += weight
    }
    return Math.max(0.35, maintainingWeight / totalWeight)
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
  // Returns why the resulting position is done, or null when no such capture exists.
  function userCaptureIntoDoneReason(
    chess: Chess,
    doneReason: (chess: Chess) => DonePositionReason | null,
  ): DonePositionReason | null {
    for (const move of chess.moves({ verbose: true })) {
      if (!move.isCapture() && !move.isEnPassant()) continue
      chess.move(move)
      const reason = chess.isStalemate() ? null : doneReason(chess)
      chess.undo()
      if (reason) return reason
    }
    return null
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

  // Position identity for repetition detection: piece placement, side to move, castling
  // rights and en passant square — the move counters don't matter, as in the threefold rule
  function positionKey(fen: string): string {
    return fen.split(' ').slice(0, 4).join(' ')
  }

  function collectSeenPositionKeys(startFen: string, moves: string[]): Set<string> {
    const chess = new Chess(startFen)
    const keys = new Set([positionKey(chess.fen())])
    for (const uci of moves) {
      try {
        chess.move(uciToMoveArgs(uci))
      } catch {
        break
      }
      keys.add(positionKey(chess.fen()))
    }
    return keys
  }

  function moveRepeatsSeenPosition(
    currentFen: string,
    uci: string,
    seenPositionKeys: Set<string>,
  ): boolean {
    try {
      const chess = new Chess(currentFen)
      chess.move(uciToMoveArgs(uci))
      return seenPositionKeys.has(positionKey(chess.fen()))
    } catch {
      return false
    }
  }

  type DonePositionReason = 'King vs Major' | 'Insufficient Material'

  function donePositionReason(chess: Chess, playerColor: PlayerColor): DonePositionReason | null {
    const fen = chess.fen()
    if (isBareKingVsMajorPiece(fen, playerColor)) return 'King vs Major'
    if (chess.isInsufficientMaterial()) return 'Insufficient Material'
    return null
  }

  // Material balance from the computer's perspective: its piece values minus the user's
  function computerMaterialBalance(fen: string, playerColor: PlayerColor): number {
    const material = materialByColor(fen)
    return playerColor === 'white'
      ? material.black - material.white
      : material.white - material.black
  }

  // Balance after each half-move of the line, stopping at the first illegal move
  function lineMaterialBalances(
    currentFen: string,
    moves: string[],
    playerColor: PlayerColor,
  ): number[] {
    const chess = new Chess(currentFen)
    const balances: number[] = []
    for (const uci of moves) {
      try {
        chess.move(uciToMoveArgs(uci))
      } catch {
        break
      }
      balances.push(computerMaterialBalance(chess.fen(), playerColor))
    }
    return balances
  }

  // The first material level the line settles at: held for 3 consecutive half-moves
  // within the first 8. null when the material never balances out in that window.
  function stableMaterialBalance(
    currentFen: string,
    moves: string[],
    playerColor: PlayerColor,
  ): number | null {
    const balances = lineMaterialBalances(currentFen, moves, playerColor).slice(
      0,
      STABLE_BALANCE_SCAN_HALFMOVES,
    )
    for (let i = 0; i + STABLE_BALANCE_RUN_HALFMOVES <= balances.length; i++) {
      const run = balances.slice(i, i + STABLE_BALANCE_RUN_HALFMOVES)
      if (run.every((balance) => balance === run[0])) return run[0]!
    }
    return null
  }

  function computeDistanceToDone(
    line: EngineLine,
    currentFen: string,
    tbOutcome: OutcomeRetainingResult | null,
    playerColor: PlayerColor,
    startingStableMaterialBalance: number | null,
  ): { dtd: number | null; dtdReason: DtdReason | null } {
    let dtd: number | null = null
    let dtdReason: DtdReason | null = null

    // Seed from the tablebase's distance to mate (dtm is in half-moves from the position
    // after the move, so the move itself adds one). Drawn moves report dtm 0 — there is
    // no mate distance, so they must not seed anything.
    const tbMove = tbOutcome?.result.moves.find((m) => m.uci === line.moves[0])
    if (tbMove && tbMove.dtm !== null && tbMove.dtm !== 0) {
      dtd = Math.abs(tbMove.dtm) + 1
      dtdReason = 'tablebase dtm'
    }

    // Engine mate scores are in full moves
    if (dtd === null && line.scoreMate !== null) {
      dtd = 2 * Math.abs(line.scoreMate)
      dtdReason = 'engine mate'
    }

    const doneReason = (chess: Chess): DonePositionReason | null =>
      donePositionReason(chess, playerColor)

    if (doneReason(new Chess(currentFen)) !== null) return { dtd, dtdReason }

    const balances = lineMaterialBalances(currentFen, line.moves, playerColor)
    // The computer has fallen at least DONE_MATERIAL_DEFICIT pawns below the top line's
    // stable balance and stays there for the full deficit window — done, the material
    // deficit incurred is too high
    const holdsExcessiveDeficit = (balanceIndex: number): boolean => {
      if (startingStableMaterialBalance === null) return false
      const window = balances.slice(balanceIndex, balanceIndex + DEFICIT_WINDOW_LENGTH)
      const isExcessiveDeficit = (balance: number): boolean =>
        balance <= startingStableMaterialBalance - DONE_MATERIAL_DEFICIT
      return window.length === DEFICIT_WINDOW_LENGTH
        ? window.every(isExcessiveDeficit)
        : window.some(isExcessiveDeficit)
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
      const positionReason = doneReason(chess)
      if (positionReason !== null || holdsExcessiveDeficit(i)) {
        if (halfMovesPlayed < (dtd ?? Infinity)) {
          dtd = halfMovesPlayed
          dtdReason = positionReason ? `LineProbe ${positionReason}` : 'LineProbe Material deficit'
        }
        break
      }
      // The line tracks the fastest mate, which can leave a blundered piece hanging
      // forever (capturing it would only slow the mate down) — but the user would just
      // take it and call the position done, so probe their one-move deviations too
      const isUserToMove = i % 2 === 0
      const captureReason = isUserToMove ? userCaptureIntoDoneReason(chess, doneReason) : null
      if (captureReason !== null) {
        if (halfMovesPlayed + 1 < (dtd ?? Infinity)) {
          dtd = halfMovesPlayed + 1
          dtdReason = `LineProbe Capture into ${captureReason}`
        }
        break
      }
    }

    return { dtd, dtdReason }
  }

  // A candidate with a larger tablebase mate distance is the more resistant defense, no
  // matter what the line probes found: each candidate's PV picks an arbitrary winning
  // plan for the user (fast promotion in one line, a slow pawn hunt in another), so probe
  // distances from different PVs are not comparable and must not undercut the tablebase's
  // exact resistance ordering. And since the extra resistance a higher-dtm defense buys
  // happens before the collapse into a done position (the mopping-up tail after the
  // collapse is much alike across lines), the dtd gap should be at least the dtm gap —
  // not merely non-negative. Candidates are walked in groups of ascending dtm, flooring
  // every dtd at the best dtd-relative-to-dtm shift seen among faster-mate groups plus
  // the candidate's own dtm; within a group (equal dtm) the probes' ordering is kept.
  function clampDistancesToTablebaseOrdering(
    candidates: EngineLineWithDTD[],
    tbOutcome: OutcomeRetainingResult | null,
  ): void {
    if (!tbOutcome) return
    const dtmOf = (line: EngineLineWithDTD): number | null => {
      const tbMove = tbOutcome.result.moves.find((m) => m.uci === line.moves[0])
      return tbMove && tbMove.dtm !== null && tbMove.dtm !== 0 ? Math.abs(tbMove.dtm) : null
    }
    const ranked = candidates
      .flatMap((candidate) => {
        const dtm = dtmOf(candidate)
        return dtm !== null && candidate.dtd !== null ? [{ candidate, dtm }] : []
      })
      .sort((a, b) => a.dtm - b.dtm)

    let maxDtdMinusDtmOfFasterMates = -Infinity
    let index = 0
    while (index < ranked.length) {
      const groupDtm = ranked[index]!.dtm
      const group: EngineLineWithDTD[] = []
      while (index < ranked.length && ranked[index]!.dtm === groupDtm) {
        group.push(ranked[index]!.candidate)
        index++
      }
      const dtdFloor =
        maxDtdMinusDtmOfFasterMates === -Infinity ? 0 : maxDtdMinusDtmOfFasterMates + groupDtm
      for (const candidate of group) {
        if (candidate.dtd! < dtdFloor) {
          candidate.dtd = dtdFloor
          candidate.dtdReason = 'tablebase ordering'
        }
      }
      maxDtdMinusDtmOfFasterMates = Math.max(
        maxDtdMinusDtmOfFasterMates,
        ...group.map((c) => c.dtd! - groupDtm),
      )
    }
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
    // No trustworthy dtd for every line (typically an engine-only loss without a mate
    // score) — fall back to the engine's scores: it minimizes |scoreCP| when losing, and
    // the cp ordering tracks the tablebase's distance-to-mate ordering well. Weight by
    // the gap to the least-bad candidate, since the absolute evaluations are all equally
    // hopeless and only the differences carry the resistance signal.
    const absoluteCps = candidates.map((c) =>
      c.scoreCP !== null ? Math.abs(c.scoreCP) : MATE_ONLY_FALLBACK_CP,
    )
    const leastBadCp = Math.min(...absoluteCps)
    return normalizeWeights(
      absoluteCps.map((cp) => 2 ** (-(cp - leastBadCp) / CP_FALLBACK_HALVING_GAP)),
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
        .then((lines) => engineMaintainFraction(probe.fen, lines, userOutcomeWithBestPlay))
      lineProducts[probe.lineIndex] = lineProducts[probe.lineIndex]! * fraction
    }

    const weights = normalizeWeights(
      lineProducts.map((product) => 1 / Math.min(1, Math.max(EPSILON, product))),
    )
    return { weights, lineProducts }
  }

  async function getDrawSamplingPlan(
    candidatesWithDtd: EngineLineWithDTD[],
    currentFen: string,
    halfmoveClock: number,
    isStalledDraw: boolean,
    shouldAbort: (() => boolean) | undefined,
  ): Promise<CandidateSamplingPlan> {
    const trickster = await getSamplingWeightsTrickster(
      candidatesWithDtd,
      currentFen,
      'draw',
      shouldAbort,
    )
    let weights = trickster.weights
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
    return {
      header: `Move candidates (draw, halfmove clock ${halfmoveClock}) ${currentFen}:`,
      weights,
      describeCandidate: (i) =>
        `(fault_potential=${asPercent(1 - trickster.lineProducts[i]!)}, ` +
        `${dtdWithReason(candidatesWithDtd[i]!)})` +
        (zeroingFlags[i] ? ` zeroing_boost=x${zeroingBoost.toFixed(0)}` : ''),
    }
  }

  async function getLossSamplingPlan(
    candidatesWithDtd: EngineLineWithDTD[],
    currentFen: string,
    shouldAbort: (() => boolean) | undefined,
  ): Promise<CandidateSamplingPlan> {
    const delayerWeights = getSamplingWeightsDelayer(candidatesWithDtd)
    // In a pawnless lost position the trickster adds nothing but noise — pure piece
    // play offers no structural traps worth steering into, so the delayer decides alone
    const trickster = hasPawnsOnBoard(currentFen)
      ? await getSamplingWeightsTrickster(candidatesWithDtd, currentFen, 'loss', shouldAbort)
      : null
    return {
      header: `Move candidates (loss) ${currentFen}:`,
      weights: trickster
        ? combineDelayerAndTrickster(delayerWeights, trickster.weights)
        : delayerWeights,
      describeCandidate: (i) =>
        `w_delayer=${asPercent(delayerWeights[i]!)} ` +
        `w_trickster=${trickster ? asPercent(trickster.weights[i]!) : 'n/a'.padStart(6)} ` +
        `(fault_potential=${trickster ? asPercent(1 - trickster.lineProducts[i]!) : 'n/a'.padStart(6)}, ` +
        `${dtdWithReason(candidatesWithDtd[i]!)})`,
    }
  }

  function sampleAndLogCandidates(
    candidatesWithDtd: EngineLineWithDTD[],
    plan: CandidateSamplingPlan,
    currentFen: string,
    temperature: number,
  ): number {
    const [temperedWeights, chosenIndex] = weightedSample(plan.weights, temperature)
    console.log(plan.header + '\n')
    const byWeightDescending = [...candidatesWithDtd.keys()].sort(
      (a, b) => plan.weights[b]! - plan.weights[a]!,
    )
    for (const i of byWeightDescending) {
      const candidate = candidatesWithDtd[i]!
      console.log(
        '  ' +
          (i === chosenIndex ? '* ' : '  ') +
          `${uciToSan(currentFen, candidate.moves[0]!).padStart(5)} ${asPercent(temperedWeights[i]!)} ` +
          plan.describeCandidate(i),
      )
    }
    return chosenIndex
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

    // When lost, prefer moves that recreate a position already seen in this game: the
    // sampling otherwise lets the user shuffle back to the same position and fish for an
    // easier reply — repeating instead forces them to punish the same move again (and
    // walks toward a threefold draw if they keep stalling)
    if (outcomeWithBestUserPlay === 'loss') {
      const seenPositionKeys = collectSeenPositionKeys(startFen, moves)
      const repeatingCandidates = candidates.filter((line) =>
        moveRepeatsSeenPosition(currentFen, line.moves[0]!, seenPositionKeys),
      )
      if (repeatingCandidates.length > 0) candidates = repeatingCandidates
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

    const startingStableMaterialBalance = stableMaterialBalance(
      currentFen,
      lines[0]!.moves,
      options.playerColor,
    )
    const candidatesWithDtd: EngineLineWithDTD[] = candidates.map((line) => ({
      ...line,
      ...computeDistanceToDone(
        line,
        currentFen,
        tbOutcome,
        options.playerColor,
        startingStableMaterialBalance,
      ),
    }))
    clampDistancesToTablebaseOrdering(candidatesWithDtd, tbOutcome)

    const plan =
      outcomeWithBestUserPlay === 'draw'
        ? await getDrawSamplingPlan(
            candidatesWithDtd,
            currentFen,
            halfmoveClock,
            isStalledDraw,
            options.shouldAbort,
          )
        : await getLossSamplingPlan(candidatesWithDtd, currentFen, options.shouldAbort)
    const chosenIndex = sampleAndLogCandidates(
      candidatesWithDtd,
      plan,
      currentFen,
      options.temperature,
    )

    const chosen = candidates[chosenIndex]!
    return { bestmove: chosen.moves[0]!, scoreCP, scoreMate, tbData }
  }

  return { getBestMove }
}
