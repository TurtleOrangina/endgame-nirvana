import type { GameResult, TablebaseCategory } from '@/types'
import { CATEGORY_RANK } from '@/composables/useLichessTablebase'

// Classifies an engine evaluation (from the perspective of the side the scores belong to)
// into the outcome the mover can expect. The ±100cp window intentionally matches the
// thresholds used by evaluatePuzzleGoal below, so move selection and puzzle failure
// detection agree on what counts as winning/drawing/losing.
export function scoreToOutcome(
  scoreCP: number | null,
  scoreMate: number | null,
): GameResult | null {
  if (scoreMate !== null) return scoreMate > 0 ? 'win' : 'loss'
  if (scoreCP === null) return null
  if (scoreCP > 100) return 'win'
  if (scoreCP < -100) return 'loss'
  return 'draw'
}

export interface PuzzleGoalVerdict {
  isOutsideGoal: boolean
  // Whether the verdict came from a conclusive tablebase category rather than an engine
  // score — i.e. whether it is authoritative enough to need no second opinion.
  isTablebaseVerdict: boolean
}

// A tablebase category settles the goal on its own, with two exceptions:
//   - 'unknown' means the data is incomplete for this position (e.g. a move without a
//     category poisons the aggregate), so it is no verdict at all.
//   - 'maybe-win' / 'maybe-loss' mean the outcome is only in doubt because of the 50-move
//     rule. Read literally they favour the player (a 'maybe-loss' still counts as reaching
//     a draw goal), which lets a move that loses in practice pass as on track.
// Both are therefore left to the engine evaluation, which judges the position on the board
// rather than on the technicality.
function settlesGoal(goal: string, category: TablebaseCategory): boolean {
  if (category === 'unknown') return false
  if (goal === 'win') return category !== 'maybe-win'
  if (goal === 'draw') return category !== 'maybe-loss'
  return true
}

// scoreCP/scoreMate come straight from the engine, so they're relative to whichever side is to
// move in the analyzed position — in practice the opponent, since evaluation always runs right
// after the player's move. tablebaseCategory is queried on that same position: each candidate
// move's category is from the opponent's perspective in the resulting position, but
// useLichessTablebase.query() already reduces those to the outcome the player can force with
// best defense, so what arrives here is the player's own perspective.
export function evaluatePuzzleGoal(
  goal: string,
  scoreCP: number | null,
  scoreMate: number | null,
  tablebaseCategory: TablebaseCategory | null,
): PuzzleGoalVerdict {
  if (tablebaseCategory !== null && settlesGoal(goal, tablebaseCategory)) {
    const isOutsideGoal =
      goal === 'win'
        ? CATEGORY_RANK[tablebaseCategory] <= CATEGORY_RANK['cursed-win']
        : goal === 'draw'
          ? CATEGORY_RANK[tablebaseCategory] <= CATEGORY_RANK['syzygy-loss']
          : false
    return { isOutsideGoal, isTablebaseVerdict: true }
  }

  const effectiveCp = scoreMate === null ? scoreCP : scoreMate > 0 ? Infinity : -Infinity
  const isOutsideGoal =
    effectiveCp !== null &&
    (goal === 'win' ? effectiveCp >= -100 : goal === 'draw' ? effectiveCp >= 100 : false)
  return { isOutsideGoal, isTablebaseVerdict: false }
}
