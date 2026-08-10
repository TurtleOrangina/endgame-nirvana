/**
 * Position identity for repetition detection: piece placement, side to move, castling
 * rights and en passant square — the move counters don't matter, as in the threefold rule.
 */
export function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ')
}

/**
 * Cuts repetition loops out of a played sequence. When the same position occurs more than
 * once, everything between its first and last occurrence was slack: the side that gained
 * nothing by it could have played the continuation straight away, so a line
 * `A B X Y Z B C D` is the same achievement as `A B C D` and should be counted as four
 * moves rather than eight. The splice is legal precisely because the two positions are
 * identical, and it repeats until no position recurs, so nested loops don't survive one
 * pass.
 *
 * It is the *winning* side that usually does the shuffling — a engine that already has the
 * win in hand is under no pressure to take the fastest route — which is exactly why the
 * loops must not be credited to the defense.
 *
 * `positionKeys` are the positions the sequence passed through, starting position first,
 * so it holds one more entry than `items`.
 *
 * Used by the engine-playout measurement's trimming; kept here beside `positionKey`, which
 * useMoveSelector shares, so the two never grow separate notions of "the same position".
 */
export function withoutRepetitionLoops<T>(items: T[], positionKeys: string[]): T[] {
  let keys = positionKeys
  let result = items
  for (;;) {
    const firstRepeated = keys.findIndex((key, index) => keys.indexOf(key, index + 1) !== -1)
    if (firstRepeated === -1) return result
    const lastOccurrence = keys.lastIndexOf(keys[firstRepeated]!)
    result = [...result.slice(0, firstRepeated), ...result.slice(lastOccurrence)]
    keys = [...keys.slice(0, firstRepeated), ...keys.slice(lastOccurrence)]
  }
}
