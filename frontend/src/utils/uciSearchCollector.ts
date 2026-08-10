import type { EngineLine } from '@/types'

// Accumulates the `info` lines of a single UCI search into the per-multipv `EngineLine`s
// the app works with, and turns the closing `bestmove` line into the final result.
// Shared by the browser engine (`useStockfishEngine`, driving the Stockfish WASM worker)
// and the native-binary driver the engine-playout measurement runs on, so both
// read the engine's output through exactly the same rules.
export interface UciSearchCollector {
  // The updated lines when this info line changed them (for progress reporting),
  // otherwise null. Callers must skip lines belonging to an aborted search themselves.
  consumeInfo(infoLine: string): EngineLine[] | null
  // Final result of the search the given `bestmove` line closes
  finish(bestmoveLine: string): EngineLine[]
  reset(): void
}

export function createUciSearchCollector(): UciSearchCollector {
  let lines = new Map<number, EngineLine>()
  let lastScoreCP: number | null = null
  let lastScoreMate: number | null = null

  function sortedLines(): EngineLine[] {
    return [...lines.values()].sort((a, b) => a.multipvIndex - b.multipvIndex)
  }

  function reset(): void {
    lines = new Map()
    lastScoreCP = null
    lastScoreMate = null
  }

  function consumeInfo(infoLine: string): EngineLine[] | null {
    // Fail-high/fail-low re-search lines report a transient bound, not a real
    // evaluation, and their truncated pv would clobber a complete earlier line
    // at the same or lower depth.
    if (/ score (cp|mate) -?\d+ (upper|lower)bound/.test(infoLine)) return null

    const cpMatch = infoLine.match(/score cp (-?\d+)/)
    const mateMatch = infoLine.match(/score mate (-?\d+)/)
    const multipvMatch = infoLine.match(/multipv (\d+)/)
    const depthMatch = infoLine.match(/depth (\d+)/)
    const pvMatch = infoLine.match(/ pv (.+)$/)

    const lineScoreCP = cpMatch ? parseInt(cpMatch[1] ?? '0') : null
    const lineScoreMate = mateMatch ? parseInt(mateMatch[1] ?? '0') : null

    // Only the best line's score may become the position's evaluation — with
    // MultiPV > 1 the later lines are deliberately worse moves, and letting them
    // overwrite the score would misreport the position (e.g. a winning position
    // looking drawn because the third-best move only keeps a small edge).
    const isBestLine = !multipvMatch || multipvMatch[1] === '1'
    if (isBestLine && (cpMatch || mateMatch)) {
      lastScoreCP = lineScoreCP
      lastScoreMate = lineScoreMate
    }

    if (!multipvMatch || !pvMatch) return null

    const multipvIndex = parseInt(multipvMatch[1] ?? '1')
    const depth = depthMatch ? parseInt(depthMatch[1] ?? '0') : 0
    const existing = lines.get(multipvIndex)
    if (existing && depth < existing.depth) return null

    lines.set(multipvIndex, {
      moves: pvMatch[1]?.trim().split(' ') ?? [],
      scoreCP: lineScoreCP,
      scoreMate: lineScoreMate,
      depth,
      multipvIndex,
    })
    return sortedLines()
  }

  function finish(bestmoveLine: string): EngineLine[] {
    const collected = sortedLines()
    if (collected.length > 0) return collected

    // Extremely fast trivial searches can in theory emit a bestmove without any
    // pv info lines — synthesize a single line from the bestmove token so callers
    // still get a move. `bestmove (none)` (terminal position) stays an empty result.
    const move = bestmoveLine.split(' ')[1]
    if (!move || move === '(none)') return []
    return [
      { moves: [move], scoreCP: lastScoreCP, scoreMate: lastScoreMate, depth: 0, multipvIndex: 1 },
    ]
  }

  return { consumeInfo, finish, reset }
}
