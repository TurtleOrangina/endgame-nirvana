import type { TablebaseCategory } from '@/types'
import { CATEGORY_RANK } from '@/composables/useLichessTablebase'

// scoreCP/scoreMate come straight from the engine, so they're relative to whichever side is to
// move in the analyzed position — in practice the opponent, since evaluation always runs right
// after the player's move. tablebaseCategory is queried on that same position: each candidate
// move's category is from the opponent's perspective in the resulting position, but
// useLichessTablebase.query() already reduces those to the outcome the player can force with
// best defense, so what arrives here is the player's own perspective.
export function isOutsidePuzzleGoal(
  goal: string,
  scoreCP: number | null,
  scoreMate: number | null,
  tablebaseCategory: TablebaseCategory | null,
): boolean {
  // 'unknown' means the tablebase data is incomplete for this position (e.g. a move
  // without a category poisons the aggregate) — it is not a verdict, so fall through
  // to the engine evaluation instead of treating it as worse than any real outcome.
  if (tablebaseCategory !== null && tablebaseCategory !== 'unknown') {
    if (goal === 'win') return CATEGORY_RANK[tablebaseCategory] <= CATEGORY_RANK['cursed-win']
    if (goal === 'draw') return CATEGORY_RANK[tablebaseCategory] <= CATEGORY_RANK['syzygy-loss']
    return false
  }

  const effectiveCp = scoreMate === null ? scoreCP : scoreMate > 0 ? Infinity : -Infinity
  if (effectiveCp === null) return false
  if (goal === 'win') return effectiveCp >= 0
  if (goal === 'draw') return effectiveCp >= 100
  return false
}
