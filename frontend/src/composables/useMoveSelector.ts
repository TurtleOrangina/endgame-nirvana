import { watch } from 'vue'
import { Chess } from 'chess.js'
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
  type StockfishEngine,
} from '@/composables/useStockfishEngine'
import {
  decisiveDistance,
  decisiveDistanceScale,
  isZeroingAsDecisiveAsMate,
  useLichessTablebase,
  type OutcomeRetainingResult,
} from '@/composables/useLichessTablebase'
import { scoreToOutcome } from '@/utils/puzzleEvaluation'
import { engineMaintainFraction } from '@/utils/maintainFraction'
import { EPSILON, weightedSample } from '@/utils/weightedSample'
import { positionKey } from '@/utils/repetitionLoops'
import {
  hasPawnsOnBoard,
  isBareKingVsMajorPiece,
  materialByColor,
  uciToMoveArgs,
} from '@/utils/chess'

// How sharply the sampling peaks on the highest-weighted candidates (see weightedSample).
// Lives here rather than at the call site so the engine-playout measurement
// (src/measurements/engine-playout/) can drive the selector exactly as the board does.
export const TEMPERATURE = 0.2 // the engine defends accurately
// Pawnless positions have far fewer structural traps, so more variance is accepted to
// see more variations — mildly on the first try, generously on retries
export const TEMPERATURE_PAWNLESS_FIRST_TRY = 0.33
export const TEMPERATURE_PAWNLESS_RETRY = 0.6

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
// How strongly the delayer gates the trickster when their weights are multiplied together.
// Overridable per SelectorTuning, because it is the dial between the two halves of the
// selection: raising it buys resistance at the cost of traps, lowering it the reverse.
const DEFAULT_DELAYER_EXPONENT = 2
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
  // The engine line the sampled bestmove was taken from: the move the computer is about
  // to play, followed by the user reply the engine predicts. Feeds the draw auto-solve,
  // which needs to know what the next half-moves would look like before deciding the
  // position is just being shuffled. Null when the move came from somewhere other than
  // the engine's lines (a tablebase fallback, an injected zeroing move).
  selectedLine: EngineLine | null
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

// A candidate the Trickster did not probe has no fault potential to report
function faultPotential(survival: number | null | undefined): string {
  return survival === null || survival === undefined ? 'n/a'.padStart(6) : asPercent(1 - survival)
}

function dtdWithReason(candidate: EngineLineWithDTD): string {
  // A tablebase-seeded dtd carries a sub-ply tiebreak, so it isn't always a whole number
  const dtd = candidate.dtd === null ? '?' : Number(candidate.dtd.toFixed(2))
  return `dtd=${dtd}${candidate.dtdReason ? ` [${candidate.dtdReason}]` : ''}`
}

// The tablebase distance metric shared by the dtd seed and the ordering clamp: both must
// rank candidates identically, or the clamp undoes the seed. See `decisiveDistance`.
interface DecisiveDistanceMetric {
  zeroingIsDecisive: boolean
  scale: number
}

// How a set of candidates should be sampled, plus what to log about each one
interface CandidateSamplingPlan {
  header: string
  weights: number[]
  describeCandidate: (index: number) => string
}

/**
 * Variations of the selection the measurements play out as alternative defenders, so a
 * design question ("is the Trickster worth its search time?") is answered by a measured
 * comparison rather than by argument. The app always runs `PRODUCTION_TUNING`.
 */
export interface SelectorTuning {
  // With the Trickster off, a lost position is sampled by the delayer alone and a drawn
  // one uniformly over the outcome-retaining moves
  trickster: boolean
  // How the delayer weights candidates when they don't all have a trustworthy dtd:
  // `score-gap` by the engine's centipawn gaps, `multipv-rank` by the lines' own ordering
  delayerFallback: 'score-gap' | 'multipv-rank'
  // With this off, a tablebase-seeded dtd is the plain distance to mate. On, a position where
  // a zeroing move is as decisive as mate is seeded by whichever comes first instead, so a
  // defense that delays mate by handing over its last piece stops looking resistant.
  zeroingDistance: boolean
  // The power the delayer's weight is raised to before the Trickster's is multiplied in, so
  // it sets which of the two decides a lost position. See combineDelayerAndTrickster.
  delayerExponent: number
  // How the Trickster combines a line's per-position survival fractions: `product` down the
  // line, or their `geometric-mean`, which stops a line's weight depending on how many
  // positions its PV was long enough to probe. See getSamplingWeightsTrickster.
  tricksterAggregation: 'product' | 'geometric-mean'
  // Probe only this many candidates, the ones the delayer rates highest, giving each a
  // proportionally longer search so the Trickster costs the same. null probes them all.
  tricksterProbedCandidates: number | null
}

export const PRODUCTION_TUNING: SelectorTuning = {
  trickster: true,
  delayerFallback: 'score-gap',
  zeroingDistance: true,
  delayerExponent: DEFAULT_DELAYER_EXPONENT,
  tricksterAggregation: 'product',
  // Left at null: focusing the probes looked like a clear win (+1.43±0.64 delay moves on
  // win goals) until the same measurement was re-run with this very setting and reproduced
  // most of the gain, which makes it run-to-run drift rather than the change. See the
  // engine-playout README.
  tricksterProbedCandidates: null,
}

// The engine is injectable so the engine-playout measurement
// (src/measurements/engine-playout/) can drive this exact selection logic from
// Node, where there is no Web Worker to run the WASM build in. The app always uses the
// shared browser instance.
export function useMoveSelector(
  engine: StockfishEngine = useStockfishEngine(),
  tuning: SelectorTuning = PRODUCTION_TUNING,
) {
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
    metric: DecisiveDistanceMetric,
    playerColor: PlayerColor,
    startingStableMaterialBalance: number | null,
  ): { dtd: number | null; dtdReason: DtdReason | null } {
    let dtd: number | null = null
    let dtdReason: DtdReason | null = null

    // Seed from the tablebase's distance to resolution (in half-moves from the position
    // after the move, so the move itself adds one). Where a zeroing move is as decisive as
    // mate this is min(dtm, dtz) rather than dtm alone: there is no point delaying mate
    // along a route that hands over the last defending piece first. Drawn moves report dtm
    // 0 — there is no distance, so they must not seed anything.
    const tbMove = tbOutcome?.result.moves.find((m) => m.uci === line.moves[0])
    if (tbMove) {
      const tbDistance = decisiveDistance(tbMove, metric.zeroingIsDecisive, metric.scale)
      if (tbDistance !== null) {
        dtd = tbDistance + 1
        const zeroingCounted =
          metric.zeroingIsDecisive && (tbMove.precise_dtz ?? tbMove.dtz) !== null
        dtdReason = zeroingCounted ? 'tablebase min(dtm,dtz)' : 'tablebase dtm'
      }
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

  // A candidate the tablebase says resolves later is the more resistant defense, no matter
  // what the line probes found: each candidate's PV picks an arbitrary winning plan for the
  // user (fast promotion in one line, a slow pawn hunt in another), so probe distances from
  // different PVs are not comparable and must not undercut the tablebase's exact resistance
  // ordering. And since the extra resistance a slower-resolving defense buys happens before
  // the collapse into a done position (the mopping-up tail after the collapse is much alike
  // across lines), the dtd gap should be at least the tablebase gap — not merely
  // non-negative. Candidates are walked in groups of ascending tablebase distance, flooring
  // every dtd at the best dtd-relative-to-distance shift seen among sooner-resolving groups
  // plus the candidate's own distance; within a group the probes' ordering is kept.
  //
  // The metric must be the same one that seeded the dtds — clamping a min(dtm, dtz) seed
  // against a dtm-only ordering would floor the piece-dropping defenses straight back up.
  function clampDistancesToTablebaseOrdering(
    candidates: EngineLineWithDTD[],
    tbOutcome: OutcomeRetainingResult | null,
    metric: DecisiveDistanceMetric,
  ): void {
    if (!tbOutcome) return
    const distanceOf = (line: EngineLineWithDTD): number | null => {
      const tbMove = tbOutcome.result.moves.find((m) => m.uci === line.moves[0])
      return tbMove ? decisiveDistance(tbMove, metric.zeroingIsDecisive, metric.scale) : null
    }
    const ranked = candidates
      .flatMap((candidate) => {
        const distance = distanceOf(candidate)
        return distance !== null && candidate.dtd !== null ? [{ candidate, distance }] : []
      })
      .sort((a, b) => a.distance - b.distance)

    let maxDtdMinusDistanceOfSoonerGroups = -Infinity
    let index = 0
    while (index < ranked.length) {
      const groupDistance = ranked[index]!.distance
      const group: EngineLineWithDTD[] = []
      while (index < ranked.length && ranked[index]!.distance === groupDistance) {
        group.push(ranked[index]!.candidate)
        index++
      }
      const dtdFloor =
        maxDtdMinusDistanceOfSoonerGroups === -Infinity
          ? 0
          : maxDtdMinusDistanceOfSoonerGroups + groupDistance
      for (const candidate of group) {
        if (candidate.dtd! < dtdFloor) {
          candidate.dtd = dtdFloor
          candidate.dtdReason = 'tablebase ordering'
        }
      }
      maxDtdMinusDistanceOfSoonerGroups = Math.max(
        maxDtdMinusDistanceOfSoonerGroups,
        ...group.map((c) => c.dtd! - groupDistance),
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
    const products = delayer.map((weight, i) => weight ** tuning.delayerExponent * trickster[i]!)
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
    // score). The `multipv-rank` fallback then reads only the lines' ordering: the engine
    // sorts them best-first anyway, and in a hopeless position the scores behind that
    // ordering swing between searches while the ordering itself is comparatively steady.
    if (tuning.delayerFallback === 'multipv-rank') {
      const byLineOrder = [...candidates.keys()].sort(
        (a, b) => candidates[a]!.multipvIndex - candidates[b]!.multipvIndex,
      )
      const rankWeights = candidates.map(() => 0)
      for (const [rank, candidateIndex] of byLineOrder.entries()) {
        rankWeights[candidateIndex] = 2 ** -rank
      }
      return normalizeWeights(rankWeights)
    }

    // Otherwise fall back to the engine's scores: it minimizes |scoreCP| when losing, and
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

  /**
   * Weight each line by how easy it would be for the user to drop the ball along it. For
   * every probed user-to-move position we estimate the fraction of moves that hold the best
   * outcome; combining them over the line approximates the chance a careless user survives
   * it, and rare survival means high training value.
   *
   * How they combine matters more than it looks. A line is probed at up to LINE_PROBING
   * positions, but only as far as its PV reaches — and PV lengths across a MultiPV search
   * vary with how deep each line happened to be searched, from a couple of half-moves to
   * twenty. Multiplying the fractions therefore compares a product of five numbers below one
   * against a product of one, and the line with the longer PV looks trickier for no reason
   * that has anything to do with chess. The `geometric-mean` aggregation divides that out by
   * taking the per-probe average survival instead, so lines are comparable however far their
   * PVs happened to run.
   */
  async function getSamplingWeightsTrickster(
    candidates: EngineLineWithDTD[],
    currentFen: string,
    outcomeWithBestUserPlay: GameResult,
    shouldAbort: (() => boolean) | undefined,
    // How worth probing each candidate is — the delayer's weights, where there are any. A
    // candidate the delayer rates near zero cannot be sampled whatever the Trickster finds,
    // so probing it spends search on an answer that can't matter.
    probePriority: number[] | null = null,
  ): Promise<{ weights: number[]; lineProducts: (number | null)[] }> {
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

    // Probing fewer candidates buys a longer search on each of the ones that are left, at
    // the same total cost — breadth traded for resolution. The probe is a 20 ms MultiPV-64
    // sweep, which is a thin basis for classifying every legal move, so the trade is worth
    // testing wherever the delayer has already ruled some candidates out.
    const positionsPerCandidate = candidates.map((line) =>
      collectUserToMovePositions(line, currentFen),
    )
    const probedIndices =
      tuning.tricksterProbedCandidates === null || probePriority === null
        ? [...candidates.keys()]
        : [...candidates.keys()]
            .sort((a, b) => probePriority[b]! - probePriority[a]!)
            .slice(0, tuning.tricksterProbedCandidates)
    const isProbed = new Set(probedIndices)

    const probes: Probe[] = probedIndices.flatMap((lineIndex) =>
      positionsPerCandidate[lineIndex]!.map((fen) => ({ lineIndex, fen })),
    )
    // Budget is per *probe*, not per candidate: a line is probed as many times as its PV is
    // long enough to allow, so dropping candidates does not free a proportional share of the
    // search. Scaling by the probe counts is what actually holds the total cost fixed.
    const allProbeCount = positionsPerCandidate.reduce((sum, list) => sum + list.length, 0)
    const probeThinkingTimeMs =
      probes.length === 0
        ? PROBE_THINKING_TIME_MS
        : Math.round(PROBE_THINKING_TIME_MS * (allProbeCount / probes.length))

    // Engine probes run strictly one after another: the shared worker only supports a
    // single search, and Stockfish already saturates multiple cores on its own
    const lineProducts = candidates.map(() => 1)
    const probeCounts = candidates.map(() => 0)
    // Survival aggregated the way this tuning asks for, which is what the weights and the
    // logged fault potential both read
    const survivalOf = (lineIndex: number): number => {
      const product = lineProducts[lineIndex]!
      const count = probeCounts[lineIndex]!
      if (tuning.tricksterAggregation === 'product' || count === 0) return product
      return product ** (1 / count)
    }
    // An unprobed candidate carries no evidence either way, so it takes the mean of the
    // probed weights — a neutral factor, leaving the delayer to decide it alone
    const weightsFrom = (): number[] => {
      const weightOf = (i: number): number => 1 / Math.min(1, Math.max(EPSILON, survivalOf(i)))
      const probedMean =
        probedIndices.reduce((sum, i) => sum + weightOf(i), 0) / probedIndices.length
      return normalizeWeights(
        candidates.map((_, i) => (isProbed.has(i) ? weightOf(i) : probedMean)),
      )
    }
    const survivals = (): (number | null)[] =>
      candidates.map((_, i) => (isProbed.has(i) ? survivalOf(i) : null))

    for (const probe of probes) {
      if (shouldAbort?.()) {
        return { weights: normalizeWeights(candidates.map(() => 1)), lineProducts: survivals() }
      }

      const fraction = await engine
        .getBestMoves(probe.fen, [], probeThinkingTimeMs, PROBE_MULTIPV)
        .then((lines) => engineMaintainFraction(probe.fen, lines, userOutcomeWithBestPlay))
      lineProducts[probe.lineIndex] = lineProducts[probe.lineIndex]! * fraction
      probeCounts[probe.lineIndex] = probeCounts[probe.lineIndex]! + 1
    }

    // Reported as survival, not as the raw product, so the logged fault potential says the
    // same thing the weights were built from
    return { weights: weightsFrom(), lineProducts: survivals() }
  }

  async function getDrawSamplingPlan(
    candidatesWithDtd: EngineLineWithDTD[],
    currentFen: string,
    halfmoveClock: number,
    isStalledDraw: boolean,
    shouldAbort: (() => boolean) | undefined,
  ): Promise<CandidateSamplingPlan> {
    // Holding a draw offers no distance to maximize, so without the trickster every
    // outcome-retaining move is equally good and the sampling is uniform
    const trickster = tuning.trickster
      ? await getSamplingWeightsTrickster(candidatesWithDtd, currentFen, 'draw', shouldAbort)
      : null
    let weights = trickster?.weights ?? normalizeWeights(candidatesWithDtd.map(() => 1))
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
        `(fault_potential=${trickster ? faultPotential(trickster.lineProducts[i]) : 'n/a'.padStart(6)}, ` +
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
    const trickster =
      tuning.trickster && hasPawnsOnBoard(currentFen)
        ? await getSamplingWeightsTrickster(
            candidatesWithDtd,
            currentFen,
            'loss',
            shouldAbort,
            delayerWeights,
          )
        : null
    return {
      header: `Move candidates (loss) ${currentFen}:`,
      weights: trickster
        ? combineDelayerAndTrickster(delayerWeights, trickster.weights)
        : delayerWeights,
      describeCandidate: (i) =>
        `w_delayer=${asPercent(delayerWeights[i]!)} ` +
        `w_trickster=${trickster ? asPercent(trickster.weights[i]!) : 'n/a'.padStart(6)} ` +
        `(fault_potential=${trickster ? faultPotential(trickster.lineProducts[i]) : 'n/a'.padStart(6)}, ` +
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
      return { bestmove: null, scoreCP: null, scoreMate: null, tbData, selectedLine: null }
    }

    const scoreCP = lines[0]!.scoreCP
    const scoreMate = lines[0]!.scoreMate
    const selectionOf = (bestmove: string | null): MoveSelectionResult => ({
      bestmove,
      scoreCP,
      scoreMate,
      tbData,
      selectedLine: lines.find((line) => line.moves[0] === bestmove) ?? null,
    })

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
        return selectionOf(retainedMove)
      }
      return selectionOf(engineMove)
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
        return selectionOf(fallback)
      }
    } else {
      const engineOutcome = scoreToOutcome(scoreCP, scoreMate)
      if (engineOutcome === null) {
        return selectionOf(lines[0]!.moves[0]!)
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
      return selectionOf(candidates[0]!.moves[0]!)
    }

    const startingStableMaterialBalance = stableMaterialBalance(
      currentFen,
      lines[0]!.moves,
      options.playerColor,
    )
    // Only meaningful when the user is winning: the tablebase distances below measure how
    // long the user's conversion takes, and a drawn position has no conversion to time. The
    // scale spans the whole known-move set so every consumer keys the same move identically.
    const metric: DecisiveDistanceMetric = {
      zeroingIsDecisive:
        tuning.zeroingDistance &&
        outcomeWithBestUserPlay === 'loss' &&
        isZeroingAsDecisiveAsMate(currentFen, options.playerColor),
      scale: tbOutcome ? decisiveDistanceScale(tbOutcome.result.moves) : 1,
    }
    const candidatesWithDtd: EngineLineWithDTD[] = candidates.map((line) => ({
      ...line,
      ...computeDistanceToDone(
        line,
        currentFen,
        tbOutcome,
        metric,
        options.playerColor,
        startingStableMaterialBalance,
      ),
    }))
    clampDistancesToTablebaseOrdering(candidatesWithDtd, tbOutcome, metric)

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
    return selectionOf(chosen.moves[0]!)
  }

  return { getBestMove }
}
