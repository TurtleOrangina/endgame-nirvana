import type { GameResult, TablebaseCategory, TablebaseMove, TablebaseResult } from '@/types'
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

/**
 * Returns true when a zeroing move (DTZ) is as tactically decisive as a mating
 * sequence (DTM), making max(DTZ, DTM) a better primary metric than DTM alone.
 *
 * Only call this on positions where one side is winning with best play; the
 * result is meaningless for positions that are drawn with best play.
 *
 * Returns false when:
 *  - Either side has pawns — a pawn push resets DTZ without ending the game
 *  - The weaker side has only a king — nothing to capture, so DTZ means losing
 *    our own pieces rather than winning theirs
 *  - The material imbalance exceeds 6 points — the winning side already has an
 *    overwhelming advantage, so capturing more seems pointless
 */
export function isDtzAsValuableAsDtm(fen: string): boolean {
  const boardPart = fen.split(' ')[0]!
  const pieces = boardPart.replace(/\d/g, '').replace(/\//g, '')

  if (pieces.includes('P') || pieces.includes('p')) return false

  const { white: whiteMaterial, black: blackMaterial } = materialByColor(fen)

  if (whiteMaterial === 0 || blackMaterial === 0) return false
  if (Math.abs(whiteMaterial - blackMaterial) > 6) return false

  return true
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
// When isDtzValuable: zeroing first, then max(DTM, DTZ) as the combined metric — capturing
// the enemy piece resolves the position as surely as mate, so whichever path ends things
// soonest should lead.
function compareMoves(a: TablebaseMove, b: TablebaseMove, isDtzValuable: boolean): number {
  const rankDiff = CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]
  if (rankDiff !== 0) return rankDiff
  const weAreWinning = CATEGORY_RANK[a.category] < CATEGORY_RANK['draw']
  const aEndsGame = a.checkmate || a.stalemate || a.insufficient_material
  const bEndsGame = b.checkmate || b.stalemate || b.insufficient_material
  if (aEndsGame !== bEndsGame) return weAreWinning === aEndsGame ? -1 : 1

  if (isDtzValuable && a.dtm !== null && b.dtm !== null && a.dtz !== null && b.dtz !== null) {
    if (a.zeroing !== b.zeroing) return weAreWinning === a.zeroing ? -1 : 1
    const effectiveDiff = Math.max(b.dtm, b.dtz) - Math.max(a.dtm, a.dtz)
    if (effectiveDiff !== 0) return effectiveDiff
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

      const moves: TablebaseMove[] = (data.moves ?? []).map((m) => ({
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

      if (moves.length === 0) return null

      const category = moves.reduce<TablebaseCategory>(
        (best, m) => (CATEGORY_RANK[m.category] < CATEGORY_RANK[best] ? m.category : best),
        moves[0]!.category,
      )

      const isDtzValuable = isDtzAsValuableAsDtm(fen)
      moves.sort((a, b) => compareMoves(a, b, isDtzValuable))

      return { category, moves }
    } catch {
      return null
    }
  }

  // Like query(), but additionally reduced to what matters for move selection: the best
  // outcome the mover can force and the moves that retain it. Returns null when the
  // position isn't completely solved by the tablebase (query failure or any
  // unknown-category move), so callers can defer to the engine instead.
  async function queryOutcomeRetaining(fen: string): Promise<OutcomeRetainingResult | null> {
    const result = await query(fen)
    if (!result) return null
    if (result.moves.some((m) => m.category === 'unknown')) return null

    const bestOutcome = categoryToOutcome(flipCategory(result.category))
    if (bestOutcome === null) return null
    const outcomeRetainingMoves = result.moves.filter(
      (m) => categoryToOutcome(flipCategory(m.category)) === bestOutcome,
    )
    return { result, bestOutcome, outcomeRetainingMoves }
  }

  return { query, queryOutcomeRetaining }
}
