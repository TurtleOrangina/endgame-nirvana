import { ELO_BAND } from '@/stores/exercises'

export type PuzzleDifficultyBand = 'harder' | 'match' | 'easier'

// Buckets a puzzle's elo relative to the user's elo for the Browse Exercises page:
// more than ELO_BAND above -> harder (red), within the band -> match (yellow/orange),
// more than ELO_BAND below -> easier (green).
export function puzzleDifficultyBand(puzzleElo: number, userElo: number): PuzzleDifficultyBand {
  const diff = puzzleElo - userElo
  if (diff > ELO_BAND) return 'harder'
  if (diff < -ELO_BAND) return 'easier'
  return 'match'
}
