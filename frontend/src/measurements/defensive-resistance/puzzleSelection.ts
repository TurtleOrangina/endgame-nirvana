import { readFileSync } from 'node:fs'
import { normalizeFen } from '@/utils/exerciseId'

// The Lichess tablebase answers positions up to 7 men, but only positions this small are
// guaranteed to stay inside it for the whole playout after a promotion adds a piece.
const MAX_PIECE_COUNT = 6

// The one position the measurement is really about: a bare queen against a bare rook,
// starting from the middle of the board. Engines defend this famously well, so it is the
// endgame where over-tuned resistance would frustrate users first.
export const QUEEN_VS_ROOK_FEN = '8/8/4r3/4k3/8/3QK3/8/8 w - - 0 1'

const PAWN_ENDGAME_PREFIX = '/Pawn Endgames'
const ROOK_ENDGAME_PREFIX = '/♖ vs ♜'

export type PuzzleGroup = 'Queen vs Rook' | 'Pawn Endgames' | 'Rook Endgames' | 'Other'

export interface SelectedPuzzle {
  group: PuzzleGroup
  categoryPath: string
  fen: string
  difficulty: number
  pieceCount: number
}

interface CatalogEntry {
  fen: string
  expected_result: string
  difficulty: number
}

export function countPieces(fen: string): number {
  return (fen.split(' ')[0] ?? '').replaceAll(/[^a-z]/gi, '').length
}

// Deterministic PRNG (mulberry32) so a run picks the same puzzles and plays the same
// sampled defenses every time — the measurement is only comparable across engine changes
// if the randomness it feeds on is held fixed.
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d_2b_79_f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

interface Candidate extends Omit<SelectedPuzzle, 'group'> {
  expectedResult: string
}

function loadCandidates(catalogPath: string): Candidate[] {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')) as Record<string, CatalogEntry[]>
  return Object.entries(catalog).flatMap(([categoryPath, entries]) =>
    entries.map((entry) => {
      const fen = normalizeFen(entry.fen)
      return {
        categoryPath,
        fen,
        difficulty: entry.difficulty,
        pieceCount: countPieces(fen),
        expectedResult: entry.expected_result,
      }
    }),
  )
}

/**
 * Picks the puzzle set the measurement runs on: the fixed queen-vs-rook position plus
 * `perGroupCount` random ones from each of pawn endgames, rook endgames, and everything
 * else.
 *
 * Only positions the side to move *wins* are eligible. Distance-to-mate is the whole
 * metric here, and a drawn position simply has none — measuring how much resistance a
 * defender gives up in a position nobody can win is meaningless.
 */
export function selectPuzzles(
  catalogPath: string,
  seed: number,
  perGroupCount: number,
): SelectedPuzzle[] {
  const random = createSeededRandom(seed)
  const candidates = loadCandidates(catalogPath).filter(
    (candidate) =>
      candidate.pieceCount <= MAX_PIECE_COUNT &&
      candidate.expectedResult === 'win' &&
      candidate.fen !== QUEEN_VS_ROOK_FEN,
  )

  const inGroup = (group: PuzzleGroup) => (candidate: Candidate) => {
    const isPawnEndgame = candidate.categoryPath.startsWith(PAWN_ENDGAME_PREFIX)
    const isRookEndgame = candidate.categoryPath.startsWith(ROOK_ENDGAME_PREFIX)
    if (group === 'Pawn Endgames') return isPawnEndgame
    if (group === 'Rook Endgames') return isRookEndgame
    return !isPawnEndgame && !isRookEndgame
  }

  const queenVsRook = loadCandidates(catalogPath).find(
    (candidate) => candidate.fen === QUEEN_VS_ROOK_FEN,
  )
  if (!queenVsRook) {
    throw new Error(`The queen-vs-rook reference puzzle is missing from ${catalogPath}`)
  }

  const groups: PuzzleGroup[] = ['Pawn Endgames', 'Rook Endgames', 'Other']
  return [
    { ...queenVsRook, group: 'Queen vs Rook' as const },
    ...groups.flatMap((group) =>
      shuffled(candidates.filter(inGroup(group)), random)
        .slice(0, perGroupCount)
        .map((candidate) => ({ ...candidate, group })),
    ),
  ].map(({ categoryPath, fen, difficulty, pieceCount, group }) => ({
    group,
    categoryPath,
    fen,
    difficulty,
    pieceCount,
  }))
}
