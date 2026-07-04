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
  if (tablebaseCategory !== null) {
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
