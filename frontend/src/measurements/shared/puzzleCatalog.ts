import { readFileSync } from 'node:fs'
import { normalizeFen } from '@/utils/exerciseId'

export interface CatalogPuzzle {
  categoryPath: string
  fen: string
  difficulty: number
  pieceCount: number
  expectedResult: string
}

interface CatalogEntry {
  fen: string
  expected_result: string
  difficulty: number
}

// "Men" in endgame parlance: every piece and pawn on the board, kings included
export function countPieces(fen: string): number {
  return (fen.split(' ')[0] ?? '').replaceAll(/[^a-z]/gi, '').length
}

// Deterministic PRNG (mulberry32) so a run picks the same puzzles and plays the same
// sampled defenses every time — a measurement is only comparable across engine changes
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

export function shuffled<T>(items: T[], random: () => number): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j]!, result[i]!]
  }
  return result
}

export function loadCatalogPuzzles(catalogPath: string): CatalogPuzzle[] {
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
