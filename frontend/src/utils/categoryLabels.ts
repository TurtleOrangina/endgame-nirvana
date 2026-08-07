import { useLocale } from '@/composables/useLocale'
import type { en } from '@/locales/en'

type CategoryKey = keyof typeof en.exerciseCategories

// The category segments of public/exercises.json that have a translated display name. The
// top-level ones are the material relations the catalog is organised by; the deeper entries
// are the subcategories introduced alongside them. Segments that came out of the scrape
// unchanged (e.g. "Triangulation and Corresponding Squares") are not in here and are shown
// as they are — translating the whole curriculum is a separate job.
const CATEGORY_KEY_BY_SEGMENT: Record<string, CategoryKey> = {
  'Pure Pieces Endgames': 'purePieces',
  'Pawn Endgames': 'pawns',
  '♘ vs Pawns': 'knightVsPawns',
  '♘ vs ♞': 'knightVsKnight',
  '♗ vs Pawns': 'bishopVsPawns',
  '♗ vs ♝': 'bishopVsBishop',
  'Opposite Colour': 'oppositeColour',
  'Same Colour': 'sameColour',
  '♗ vs ♞': 'bishopVsKnight',
  '♖ vs Pawns': 'rookVsPawns',
  '♖ vs ♜': 'rookVsRook',
  '♖ vs ♞': 'rookVsKnight',
  '♖ vs ♝': 'rookVsBishop',
  '♕ vs ♛': 'queenVsQueen',
  '♕ vs ♜': 'queenVsRook',
  '♔♗♘ vs ♚': 'bishopKnightMate',
  '♔♕ vs ♚♛': 'queenVsQueenOnly',
  '♔♕ vs ♚♜': 'queenVsRookOnly',
  '♔♖ vs ♚♝': 'rookVsBishopOnly',
  '♔♖ vs ♚♞': 'rookVsKnightOnly',
  '♔♖♗ vs ♚♜': 'rookBishopVsRook',
}

// The display name of a single category path segment, translated where one exists.
export function categorySegmentLabel(segment: string): string {
  const key = CATEGORY_KEY_BY_SEGMENT[segment]
  if (!key) return segment
  return useLocale().t((s) => s.exerciseCategories[key].name)
}

const PURE_PIECES_SEGMENT = 'Pure Pieces Endgames'

// The display name of a full category path, e.g. "♗ vs ♝ › Same Colour". A pure-pieces
// subcategory drops its parent for a short suffix instead — the figurines already spell out
// every piece on the board, so "Pure Pieces Endgames › ♔♗♘ vs ♚" is mostly repetition, and
// too long for the training view's dropdown button.
export function categoryPathLabel(path: string): string {
  const segments = path.split('/')
  if (segments[0] === PURE_PIECES_SEGMENT && segments.length > 1) {
    const suffix = useLocale().t((s) => s.app.noPawnsSuffix)
    return `${segments.slice(1).map(categorySegmentLabel).join(' › ')} ${suffix}`
  }
  return segments.map(categorySegmentLabel).join(' › ')
}

// Everything a category path can be searched by: the raw path (so the untranslated,
// scraped subcategory names still match) plus, for each translated segment, its display
// name and its plain-word search aliases — a category named "♖ vs ♝" is otherwise
// unreachable by typing.
export function categoryPathSearchText(path: string): string {
  const { t } = useLocale()
  const extras = path.split('/').flatMap((segment) => {
    const key = CATEGORY_KEY_BY_SEGMENT[segment]
    if (!key) return []
    return [t((s) => s.exerciseCategories[key].name), t((s) => s.exerciseCategories[key].search)]
  })
  return [path, ...extras].join(' ').toLowerCase()
}
