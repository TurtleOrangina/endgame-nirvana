import { useLocale } from '@/composables/useLocale'
import type { en } from '@/locales/en'

type TagKey = keyof typeof en.exerciseTags

// The themes public/exercises.json tags puzzles with. Kept deliberately small: each tag names
// one well-known concept, so a puzzle showing two of them carries two tags rather than a
// combined name, and nothing gets a catch-all tag just to have one.
const TAG_KEY_BY_NAME: Record<string, TagKey> = {
  Breakthrough: 'breakthrough',
  'Connected Pawns': 'connectedPawns',
  'Corresponding Squares': 'correspondingSquares',
  'Floating Square': 'floatingSquare',
  'Mined Squares': 'minedSquares',
  Opposition: 'opposition',
  Outflanking: 'outflanking',
  'Outside Passed Pawn': 'outsidePassedPawn',
  'Pawn Race': 'pawnRace',
  'Pendulum/Zigzag': 'pendulumZigzag',
  'Protected Passed Pawn': 'protectedPassedPawn',
  'Queen vs Pawn on 7th': 'queenVsPawnOn7th',
  'Reserve Tempo': 'reserveTempo',
  'Rook vs Connected Pawns': 'rookVsConnectedPawns',
  'Rook vs Separated Pawns': 'rookVsSeparatedPawns',
  'Self-Protecting Pawns': 'selfProtectingPawns',
  'Separated Pawns': 'separatedPawns',
  Shouldering: 'shouldering',
  'Square of the Pawn': 'squareOfThePawn',
  Stalemate: 'stalemate',
  Triangulation: 'triangulation',
  Undermining: 'undermining',
}

// The display name of a tag, translated where one exists. A tag added to the catalog before
// its translation lands still shows, as its raw English name.
export function tagLabel(tag: string): string {
  const key = TAG_KEY_BY_NAME[tag]
  if (!key) return tag
  return useLocale().t((s) => s.exerciseTags[key])
}
