import { describe, expect, it } from 'vite-plus/test'
import { positionKey, withoutRepetitionLoops } from '@/utils/repetitionLoops'

// The positions a sequence passed through, written as bare keys — what the real callers
// derive from FENs, minus the parts positionKey already throws away
function keys(...positions: string[]): string[] {
  return positions
}

describe('positionKey', () => {
  it('ignores the move counters, as the threefold rule does', () => {
    expect(positionKey('8/8/8/4k3/8/8/8/4K3 w - - 0 1')).toBe(
      positionKey('8/8/8/4k3/8/8/8/4K3 w - - 17 42'),
    )
  })

  it('separates positions differing only in side to move or en passant rights', () => {
    expect(positionKey('8/8/8/4k3/8/8/8/4K3 w - - 0 1')).not.toBe(
      positionKey('8/8/8/4k3/8/8/8/4K3 b - - 0 1'),
    )
    expect(positionKey('8/8/8/4k3/8/8/8/4K3 w - e3 0 1')).not.toBe(
      positionKey('8/8/8/4k3/8/8/8/4K3 w - - 0 1'),
    )
  })
})

describe('withoutRepetitionLoops', () => {
  it('keeps a line that never revisits a position', () => {
    expect(withoutRepetitionLoops(['a', 'b', 'c'], keys('A', 'B', 'C', 'D'))).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('splices out the detour between a position and its return', () => {
    // A B X Y Z B C D — the four moves that wandered back to B bought nothing
    const moves = ['a', 'x', 'y', 'z', 'back', 'c', 'd']
    expect(withoutRepetitionLoops(moves, keys('A', 'B', 'X', 'Y', 'Z', 'B', 'C', 'D'))).toEqual([
      'a',
      'c',
      'd',
    ])
  })

  it('keeps splicing until no position recurs', () => {
    // A B A C D C E — two separate loops, the second only reachable after the first is gone
    const moves = ['a', 'back', 'c', 'd', 'back', 'e']
    expect(withoutRepetitionLoops(moves, keys('A', 'B', 'A', 'C', 'D', 'C', 'E'))).toEqual([
      'c',
      'e',
    ])
  })

  it('collapses a line that ends where it started', () => {
    expect(withoutRepetitionLoops(['a', 'b'], keys('A', 'B', 'A'))).toEqual([])
  })
})
