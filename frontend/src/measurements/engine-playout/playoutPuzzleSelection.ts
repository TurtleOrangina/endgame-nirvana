import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { PlayerColor } from '@/types'
import {
  createSeededRandom,
  loadCatalogPuzzles,
  shuffled,
  type CatalogPuzzle,
} from '@/measurements/shared/puzzleCatalog'
import { formatYaml, parseMappingList, type YamlValue } from './yaml'

// Above this, no tablebase can settle the position — the split the report calls out,
// since a tablebase-backed check of the defence is impossible for them
export const MAX_TABLEBASE_MEN = 7

export interface PlayoutPuzzle {
  fen: string
  categoryPath: string
  goal: string
  difficulty: number
  men: number
  /**
   * The defender moves first from this position rather than the user, so the user is the
   * side *not* to move. Catalog puzzles are always the other way round; this is for the
   * positions the divergence study lifts out of the middle of a recorded playout, where the
   * whole point is the move the defender is about to choose. Absent means false, so the
   * committed puzzle set keeps parsing unchanged.
   */
  defenderToMoveFirst?: boolean
}

// The side standing in for the user — the side to move, unless the position was captured
// with the defender on move
export function userColorOf(
  puzzle: Pick<PlayoutPuzzle, 'fen' | 'defenderToMoveFirst'>,
): PlayerColor {
  const turn: PlayerColor = puzzle.fen.split(' ')[1] === 'w' ? 'white' : 'black'
  if (!puzzle.defenderToMoveFirst) return turn
  return turn === 'white' ? 'black' : 'white'
}

// The four strata the sample is balanced over, so every subsplit the report gives
// (many-men, win goal, draw goal) rests on the same number of puzzles
const STRATA = ['win-manyMen', 'win-fewMen', 'draw-manyMen', 'draw-fewMen'] as const
type Stratum = (typeof STRATA)[number]

function stratumOf(puzzle: CatalogPuzzle): Stratum | null {
  const menPart = puzzle.pieceCount > MAX_TABLEBASE_MEN ? 'manyMen' : 'fewMen'
  if (puzzle.expectedResult === 'win') return `win-${menPart}`
  if (puzzle.expectedResult === 'draw') return `draw-${menPart}`
  return null
}

function samplePuzzles(catalogPath: string, seed: number, totalCount: number): PlayoutPuzzle[] {
  const random = createSeededRandom(seed)
  const perStratum = Math.floor(totalCount / STRATA.length)
  const candidates = loadCatalogPuzzles(catalogPath)
  return STRATA.flatMap((stratum) =>
    shuffled(
      candidates.filter((candidate) => stratumOf(candidate) === stratum),
      random,
    )
      .slice(0, perStratum)
      .map((candidate) => ({
        fen: candidate.fen,
        categoryPath: candidate.categoryPath,
        goal: candidate.expectedResult,
        difficulty: candidate.difficulty,
        men: candidate.pieceCount,
      })),
  )
}

/**
 * The puzzle set is committed to disk rather than re-derived from the seed on every run.
 * A seed alone is not enough: `exercises.json` is refreshed periodically from prod, and
 * any change to it would silently re-sample the set, making a new run's numbers
 * incomparable to the committed baseline without anything looking wrong.
 */
export function loadOrCreatePuzzleSet(
  puzzleSetPath: string,
  catalogPath: string,
  seed: number,
  totalCount: number,
  resample: boolean,
): PlayoutPuzzle[] {
  if (!resample && existsSync(puzzleSetPath)) {
    const rows = parseMappingList(readFileSync(puzzleSetPath, 'utf8'), 'puzzles')
    return rows.map((row) => ({
      fen: String(row.fen),
      categoryPath: String(row.categoryPath),
      goal: String(row.goal),
      difficulty: Number(row.difficulty),
      men: Number(row.men),
      ...(row.defenderToMoveFirst === true ? { defenderToMoveFirst: true } : {}),
    }))
  }

  const puzzles = samplePuzzles(catalogPath, seed, totalCount)
  const rows: YamlValue = puzzles.map((puzzle) => ({ ...puzzle }))
  writeFileSync(
    puzzleSetPath,
    '# The fixed puzzle set the engine-playout measurement runs on — commit it.\n' +
      '# Regenerate only with --resample, which invalidates comparisons to older baselines.\n' +
      formatYaml({ seed, count: puzzles.length, puzzles: rows }),
  )
  return puzzles
}
