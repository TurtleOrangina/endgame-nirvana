import type { TablebaseCategory, TablebaseMove, TablebaseResult } from '@/types'

const TABLEBASE_URL = 'https://tablebase.lichess.ovh/standard'

const EPSILON = 1e-6

const PIECE_VALUE: Record<string, number> = { q: 9, r: 5, b: 3, n: 3 }

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

  let whiteMaterial = 0
  let blackMaterial = 0
  for (const piece of pieces) {
    const value = PIECE_VALUE[piece.toLowerCase()]
    if (value === undefined) continue
    if (piece === piece.toUpperCase()) whiteMaterial += value
    else blackMaterial += value
  }

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

function weightedSample(
  candidates: TablebaseMove[],
  weights: number[],
  temperature: number,
): TablebaseMove {
  const total = weights.reduce((s, w) => s + w, 0)
  const normalized_weights = weights.map((w) => w / total)
  const exponent = 1 / Math.max(0.01, temperature) // Lower cap temperature to avoid division by zero
  const scaled_weights = normalized_weights.map((w) => w ** exponent)
  const scaled_total = scaled_weights.reduce((s, w) => s + w, 0)
  console.log(
    'Picking defensive move from:',
    candidates
      .map((m, i) => `${m.san} ${((scaled_weights[i]! / scaled_total) * 100).toFixed(1)}%`)
      .join(', '),
    `temperature = ${temperature.toFixed(2)}`,
  )

  let r = Math.random() * scaled_total
  for (let i = 0; i < candidates.length; i++) {
    r -= scaled_weights[i]!
    if (r <= 0) return candidates[i]!
  }
  throw new Error('Unreachable')
}

export function useLichessTablebase() {
  async function query(fen: string): Promise<TablebaseResult | null> {
    try {
      const response = await fetch(`${TABLEBASE_URL}?fen=${encodeURIComponent(fen)}`)
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

  function selectBestMove(
    result: TablebaseResult,
    temperature: number,
    fen: string,
  ): string | null {
    // Any unknown-category move means tablebase data is incomplete — defer to engine
    if (result.moves.some((m) => m.category === 'unknown')) return null
    // Engine plays out draws
    if (result.category === 'draw') {
      return null
    }
    if (CATEGORY_RANK[result.category] < CATEGORY_RANK['draw']) {
      // Computer winning, just pick best
      console.log('Using tablebase to pick the strongest win for the computer')
      return result.moves[0]?.uci ?? null
    }
    // Computer is losing, use temperature controlled weighted random sampling
    // to provide a strong defensive challenge that tests all difficult paths
    // Moves that are harder for the attacker to convert (higher DTM/DTZ/DTC)
    // get more weight; temperature controls how tightly the distribution peaks.
    //
    // When DTZ is as valuable as DTM (see isDtzAsValuableAsDtm): weight = max(ε, min over
    // non-null metrics of max(0, metric − 3)) ** 1/temperature
    //
    // Otherwise, a zeroing capture isn't necessarily as good as delaying mate, so DTM must
    // dominate: weight = max(ε, max(0, dtm + (dtz + dtc)/100 − 3)) ** 1/temperature, requires
    // every candidate to have a DTM — without it we can't rank moves this way, so defer to
    // the engine instead.

    // Keep only moves that maintain the position's best achievable outcome
    const candidates = result.moves.filter((m) => m.category === result.category)
    if (candidates.length === 0) return null

    const isDtzValuable = isDtzAsValuableAsDtm(fen)
    if (!isDtzValuable) {
      // In situations where zeroing is not as valuable, decrease the temperature for tighter play
      temperature /= 3
    }
    const allCandidatesHaveDtm = candidates.every((m) => m.dtm !== null)
    if (!isDtzValuable && !allCandidatesHaveDtm) return null

    const weights = candidates.map((m) => {
      if (!isDtzValuable) {
        const weight = Math.max(0, m.dtm! + ((m.dtz ?? 0) + (m.dtc ?? 0)) / 100 - 3)
        return Math.max(EPSILON, weight)
      }
      const slacks = ([m.dtm, m.dtz, m.dtc] as (number | null)[])
        .filter((v): v is number => v !== null)
        .map((v) => Math.max(0, v - 3))
      const slack = slacks.length > 0 ? Math.min(...slacks) : 0
      return Math.max(EPSILON, slack)
    })

    return weightedSample(candidates, weights, temperature).uci ?? null
  }

  return { query, selectBestMove }
}
