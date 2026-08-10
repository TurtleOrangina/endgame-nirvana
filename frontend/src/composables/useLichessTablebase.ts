import type {
  GameResult,
  PlayerColor,
  TablebaseCategory,
  TablebaseMove,
  TablebaseResult,
} from '@/types'
import { materialByColor } from '@/utils/chess'

const TABLEBASE_URL = 'https://tablebase.lichess.ovh/standard'

// The tablebase needs no authentication, but rate-limits aggressively: any 429 means
// backing off from all requests for a full minute (per the Lichess API guidelines).
const RATE_LIMIT_BACKOFF_MS = 60_000
let rateLimitedUntil = 0

// Successful lookups are cached for the session (module scope — the composable is
// constructed per-caller). Shuffling revisits positions constantly, and analysis and
// move selection often probe the same position near-simultaneously, so the cache holds
// in-flight promises: the second caller awaits the first request instead of repeating
// it. Failed lookups are evicted so they can be retried.
const cachedQueries = new Map<string, Promise<TablebaseResult | null>>()

// The fullmove number never affects the result, but the halfmove clock must stay in the
// key: it decides whether a win still fits within the 50-move rule (cursed wins).
function cacheKey(fen: string): string {
  return fen.split(' ').slice(0, 5).join(' ')
}

export const CATEGORY_RANK: Record<TablebaseCategory, number> = {
  win: 4,
  'syzygy-win': 3,
  'maybe-win': 2,
  'cursed-win': 1,
  draw: 0,
  'blessed-loss': -1,
  'maybe-loss': -2,
  'syzygy-loss': -3,
  loss: -4,
  unknown: -5,
}

const RANK_TO_CATEGORY: Record<number, TablebaseCategory> = Object.fromEntries(
  Object.entries(CATEGORY_RANK).map(([cat, rank]) => [rank, cat as TablebaseCategory]),
)

function parseCategory(cat: string | undefined): TablebaseCategory {
  return (cat ?? '') in CATEGORY_RANK ? (cat as TablebaseCategory) : 'unknown'
}

export function flipCategory(cat: TablebaseCategory): TablebaseCategory {
  if (cat === 'unknown') return 'unknown'
  return RANK_TO_CATEGORY[-CATEGORY_RANK[cat]]!
}

// Collapses a tablebase category (in the mover's perspective — flip a raw move category
// first, since those describe the resulting position from the opponent's side) into the
// game outcome the mover can force. Cursed wins / blessed losses count as draws because
// the 50-move rule rescues the defender.
export function categoryToOutcome(cat: TablebaseCategory): GameResult | null {
  switch (cat) {
    case 'win':
    case 'syzygy-win':
    case 'maybe-win':
      return 'win'
    case 'cursed-win':
    case 'draw':
    case 'blessed-loss':
      return 'draw'
    case 'unknown':
      return null
    default:
      return 'loss'
  }
}

// Ranks (1-8, from white's side) that hold at least one pawn of the given colour
function pawnRanks(fen: string, color: PlayerColor): number[] {
  const pawn = color === 'white' ? 'P' : 'p'
  return fen
    .split(' ')[0]!
    .split('/')
    .flatMap((row, index) => (row.includes(pawn) ? [8 - index] : []))
}

export function opposingColor(color: PlayerColor): PlayerColor {
  return color === 'white' ? 'black' : 'white'
}

/**
 * Returns true when a zeroing move (DTZ) is as tactically decisive as a mating
 * sequence (DTM), making the whichever-comes-first distance a better primary metric
 * than DTM alone (see `decisiveDistance`).
 *
 * Only call this on positions where one side is winning with best play; the
 * result is meaningless for positions that are drawn with best play, which is why
 * a null `winningColor` returns false.
 *
 * True in two shapes:
 *  - **Pawnless**: winning one of the defending pieces typically leaves a trivial
 *    position (queen vs rook, rook+bishop vs rook, rook vs bishop), so there is no
 *    point delaying mate by a route that drops a piece on the way.
 *  - **Only the winner has pawns, all of them one step from promoting**: a promotion
 *    that preserves the win resolves the position about as surely as a capture does
 *    (rook+pawn vs rook, say). A pawn further back does not qualify — DTZ would then
 *    count a push that merely resets the clock instead of ending anything.
 *
 * Returns false when:
 *  - The weaker side has only a king — nothing to capture, so DTZ means losing
 *    our own pieces rather than winning theirs
 *  - The material imbalance exceeds 6 points — the winning side already has an
 *    overwhelming advantage, so capturing more seems pointless
 */
export function isZeroingAsDecisiveAsMate(fen: string, winningColor: PlayerColor | null): boolean {
  if (winningColor === null) return false

  const { white: whiteMaterial, black: blackMaterial } = materialByColor(fen)
  if (whiteMaterial === 0 || blackMaterial === 0) return false
  if (Math.abs(whiteMaterial - blackMaterial) > 6) return false

  if (pawnRanks(fen, opposingColor(winningColor)).length > 0) return false
  const winnerPawnRanks = pawnRanks(fen, winningColor)
  if (winnerPawnRanks.length === 0) return true

  const promotionRank = winningColor === 'white' ? 7 : 2
  return winnerPawnRanks.length === 1 && winnerPawnRanks[0] === promotionRank
}

function zeroingDistance(move: TablebaseMove): number | null {
  return move.precise_dtz ?? move.dtz
}

/**
 * Scales the tiebreak term of `decisiveDistance` for one tablebase response.
 *
 * The tiebreak must stay below half a ply so it can never reorder two moves whose
 * leading distance already differs. Dividing by twice the response's own largest
 * distance guarantees that while keeping the term as wide as the bound allows — a
 * fixed divisor large enough for the longest tablebase mates (~550 plies) would
 * squash the tiebreak down to noise in the ordinary positions this app trains.
 *
 * Must be computed once over the full known-move set, so every consumer keys the same
 * move identically; distances are therefore only comparable within a single position.
 */
export function decisiveDistanceScale(moves: TablebaseMove[]): number {
  const largestDistance = moves.reduce(
    (largest, move) =>
      Math.max(largest, Math.abs(move.dtm ?? 0), Math.abs(zeroingDistance(move) ?? 0)),
    0,
  )
  return 2 * largestDistance + 1
}

/**
 * How far this move leaves the position from resolving, in half-moves: the mate distance,
 * or — where zeroing is as decisive as mate — whichever of mate and the next zeroing move
 * comes first, with the other one as a sub-ply tiebreak. The winning side minimizes this,
 * a tenacious defender maximizes it.
 *
 * Null for drawn moves (dtm 0 or absent): they have no distance to anything.
 */
export function decisiveDistance(
  move: TablebaseMove,
  zeroingIsDecisive: boolean,
  scale: number,
): number | null {
  if (move.dtm === null || move.dtm === 0) return null
  const mateDistance = Math.abs(move.dtm)
  const rawZeroingDistance = zeroingDistance(move)
  if (!zeroingIsDecisive || rawZeroingDistance === null) return mateDistance
  const zeroing = Math.abs(rawZeroingDistance)
  return Math.min(zeroing, mateDistance) + Math.max(zeroing, mateDistance) / scale
}

// Move categories are from the opponent's perspective in the resulting position.
// "loss" (rank 1) means the opponent is losing → best for the current player → sort first.
// Within the same category, direction depends on whether we're winning or losing:
//   winning (rank < CATEGORY_RANK['draw']): prefer game-ending / zeroing and lower DTZ/DTM/DTC (finish faster)
//   losing  or drawing (rank >= CATEGORY_RANK['draw']): prefer game-ending / non-zeroing and higher DTZ/DTM/DTC (delay longer)
// Game-ending moves (checkmate/stalemate/insufficient material) outrank zeroing because
// they resolve the position immediately. Lichess reports DTZ/DTM/DTC with sign already
// adjusted for outcome, so descending order (b − a) works correctly for both cases.
//
// When zeroingIsDecisive: zeroing first, then `decisiveDistance` as the combined metric —
// capturing the enemy piece (or promoting) resolves the position as surely as mate, so
// whichever path ends things soonest should lead. Unlike the raw DTZ/DTM fields that metric
// is unsigned, so the direction has to be applied explicitly here.
function compareMoves(
  a: TablebaseMove,
  b: TablebaseMove,
  zeroingIsDecisive: boolean,
  scale: number,
): number {
  const rankDiff = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]
  if (rankDiff !== 0) return rankDiff
  const weAreWinning = CATEGORY_RANK[a.category] < CATEGORY_RANK['draw']
  const aEndsGame = a.checkmate || a.stalemate || a.insufficient_material
  const bEndsGame = b.checkmate || b.stalemate || b.insufficient_material
  if (aEndsGame !== bEndsGame) return weAreWinning === aEndsGame ? -1 : 1

  if (zeroingIsDecisive && a.dtm !== null && b.dtm !== null && a.dtz !== null && b.dtz !== null) {
    if (a.zeroing !== b.zeroing) return weAreWinning === a.zeroing ? -1 : 1
    const aDistance = decisiveDistance(a, true, scale) ?? 0
    const bDistance = decisiveDistance(b, true, scale) ?? 0
    const distanceDiff = weAreWinning ? aDistance - bDistance : bDistance - aDistance
    if (distanceDiff !== 0) return distanceDiff
    return (b.dtc ?? -Infinity) - (a.dtc ?? -Infinity)
  }

  const dtmDiff = (b.dtm ?? -Infinity) - (a.dtm ?? -Infinity)
  if (dtmDiff !== 0) return dtmDiff
  if (a.zeroing !== b.zeroing) return weAreWinning === a.zeroing ? -1 : 1
  const dtzDiff = (b.dtz ?? -Infinity) - (a.dtz ?? -Infinity)
  if (dtzDiff !== 0) return dtzDiff
  return (b.dtc ?? -Infinity) - (a.dtc ?? -Infinity)
}

export interface OutcomeRetainingResult {
  result: TablebaseResult
  // Best outcome the side to move can force, in that side's own perspective
  bestOutcome: GameResult
  // Moves that keep that outcome, preserving the sorted order of result.moves
  outcomeRetainingMoves: TablebaseMove[]
}

export function useLichessTablebase() {
  async function query(fen: string): Promise<TablebaseResult | null> {
    const key = cacheKey(fen)
    const cached = cachedQueries.get(key)
    if (cached) return cached
    if (Date.now() < rateLimitedUntil) return null
    const pending = fetchTablebase(fen)
    cachedQueries.set(key, pending)
    const result = await pending
    if (result === null) cachedQueries.delete(key)
    return result
  }

  async function fetchTablebase(fen: string): Promise<TablebaseResult | null> {
    try {
      const response = await fetch(`${TABLEBASE_URL}?fen=${encodeURIComponent(fen)}`)
      if (response.status === 429) {
        rateLimitedUntil = Date.now() + RATE_LIMIT_BACKOFF_MS
        return null
      }
      if (!response.ok) return null

      const data = (await response.json()) as {
        category?: string
        moves?: Array<{
          uci: string
          san: string
          zeroing?: boolean
          conversion?: boolean
          checkmate?: boolean
          stalemate?: boolean
          insufficient_material?: boolean
          dtz?: number | null
          precise_dtz?: number | null
          dtm?: number | null
          dtw?: number | null
          dtc?: number | null
          category?: string
        }>
      }

      const allMoves: TablebaseMove[] = (data.moves ?? []).map((m) => ({
        uci: m.uci,
        san: m.san,
        zeroing: m.zeroing ?? false,
        conversion: m.conversion ?? false,
        checkmate: m.checkmate ?? false,
        stalemate: m.stalemate ?? false,
        insufficient_material: m.insufficient_material ?? false,
        dtz: m.dtz ?? null,
        precise_dtz: m.precise_dtz ?? null,
        dtm: m.dtm ?? null,
        dtw: m.dtw ?? null,
        dtc: m.dtc ?? null,
        category: parseCategory(m.category),
      }))

      if (allMoves.length === 0) return null

      // Derived from every legal move (unknown ranks lowest), so the overall category stays
      // 'unknown' whenever any move is off-tablebase — the signal callers use to know the
      // position isn't fully solved and fall back to the engine.
      const category = allMoves.reduce<TablebaseCategory>(
        (best, m) => (CATEGORY_RANK[m.category] < CATEGORY_RANK[best] ? m.category : best),
        allMoves[0]!.category,
      )

      // Unknown-category moves carry no tablebase verdict (e.g. 8-piece positions the
      // tablebase doesn't cover). Drop them so they can't be displayed or ranked as the
      // best move; sorting then surfaces the best *known* move first.
      const moves = allMoves.filter((m) => m.category !== 'unknown')
      if (moves.length === 0) return null

      // Which side is winning decides whether pawns disqualify the zeroing metric, so it
      // has to come from the verdict rather than from the board. An 'unknown' or drawn
      // category yields no winner, and the metric is meaningless there anyway.
      const sideToMove: PlayerColor = fen.split(' ')[1] === 'b' ? 'black' : 'white'
      const moverOutcome = categoryToOutcome(flipCategory(category))
      const winningColor =
        moverOutcome === 'win'
          ? sideToMove
          : moverOutcome === 'loss'
            ? opposingColor(sideToMove)
            : null

      const zeroingIsDecisive = isZeroingAsDecisiveAsMate(fen, winningColor)
      const scale = decisiveDistanceScale(moves)
      moves.sort((a, b) => compareMoves(a, b, zeroingIsDecisive, scale))

      return { category, moves }
    } catch {
      return null
    }
  }

  // Like query(), but additionally reduced to what matters for move selection: the best
  // outcome the mover can force and the moves that retain it. Returns null when the
  // position isn't completely solved by the tablebase (query failure or an 'unknown'
  // overall category, i.e. some legal move is off-tablebase), so callers can defer to the
  // engine instead.
  async function queryOutcomeRetaining(fen: string): Promise<OutcomeRetainingResult | null> {
    const result = await query(fen)
    if (!result) return null
    // An 'unknown' overall category means at least one legal move is off-tablebase, so the
    // position isn't fully solved — defer to the engine rather than trust a partial verdict.
    if (result.category === 'unknown') return null

    const bestOutcome = categoryToOutcome(flipCategory(result.category))
    if (bestOutcome === null) return null
    const outcomeRetainingMoves = result.moves.filter(
      (m) => categoryToOutcome(flipCategory(m.category)) === bestOutcome,
    )
    return { result, bestOutcome, outcomeRetainingMoves }
  }

  return { query, queryOutcomeRetaining }
}
