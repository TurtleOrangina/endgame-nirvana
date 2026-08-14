import { describe, expect, it } from 'vite-plus/test'
import { describeSideToMove, parseFen } from '../fen'

// The fen from a real shared link, underscores and all
const SHARED_LINK_FEN = '7R/1r6/8/8/8/8/3p1K2/3k4_b_-_-_0_1'

describe('parseFen', () => {
  it('accepts the underscore-separated form shared links carry', () => {
    const position = parseFen(SHARED_LINK_FEN)
    expect(position?.sideToMove).toBe('b')
    expect(position?.pieces).toHaveLength(5)
    expect(position?.pieces).toContainEqual({ file: 7, rank: 7, code: 'wR' })
    expect(position?.pieces).toContainEqual({ file: 3, rank: 0, code: 'bK' })
  })

  it('accepts the plain form with spaces', () => {
    expect(parseFen('7R/1r6/8/8/8/8/3p1K2/3k4 b - - 0 1')).toEqual(parseFen(SHARED_LINK_FEN))
  })

  it.each([
    ['too few ranks', '8/8/8/8/8/8/8 w - - 0 1'],
    ['a rank that does not add up to eight', '8/8/8/8/8/8/8/7 w - - 0 1'],
    ['a rank that overflows', '8/8/8/8/8/8/8/KKKKKKKKK w - - 0 1'],
    ['an unknown piece letter', '8/8/8/8/8/8/8/7X w - - 0 1'],
    ['no side to move', '8/8/8/8/8/8/8/8'],
    ['a nonsense side to move', '8/8/8/8/8/8/8/8 x - - 0 1'],
    ['nothing at all', ''],
  ])('rejects %s', (_, fen) => {
    expect(parseFen(fen)).toBeNull()
  })

  it('rejects anything long enough to be an attack rather than a position', () => {
    expect(parseFen('8/'.repeat(200))).toBeNull()
  })
})

describe('describeSideToMove', () => {
  it('names the side the reader is being asked to play', () => {
    expect(describeSideToMove(parseFen(SHARED_LINK_FEN)!)).toBe('Black to play')
    expect(describeSideToMove(parseFen('8/8/8/8/8/8/8/Kk6 w - - 0 1')!)).toBe('White to play')
  })
})
