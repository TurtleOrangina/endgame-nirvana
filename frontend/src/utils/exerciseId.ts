export function normalizeFen(fen: string): string {
  return fen.replaceAll('_', ' ')
}

// Exercise ids used to be `${categoryPath}::${rawFen}`; they're now just the
// normalized FEN, which is guaranteed globally unique in the puzzle catalog.
// Idempotent, so it's safe to run on every load rather than tracking whether
// the one-time migration already happened.
export function migrateLegacyExerciseId(id: string): string {
  const separatorIndex = id.indexOf('::')
  const fen = separatorIndex === -1 ? id : id.slice(separatorIndex + 2)
  return normalizeFen(fen)
}
