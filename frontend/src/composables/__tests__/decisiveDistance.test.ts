import { describe, expect, it } from 'vite-plus/test'
import {
  decisiveDistance,
  decisiveDistanceScale,
  isZeroingAsDecisiveAsMate,
} from '@/composables/useLichessTablebase'
import type { TablebaseMove } from '@/types'

function move(uci: string, dtm: number, dtz: number): TablebaseMove {
  return {
    uci,
    san: uci,
    zeroing: false,
    conversion: false,
    checkmate: false,
    stalemate: false,
    insufficient_material: false,
    dtz,
    precise_dtz: null,
    dtm,
    dtw: null,
    dtc: null,
    category: 'win',
  }
}

describe('decisive distance', () => {
  it('keys the probed KQ vs KR position as the defender would rank it', () => {
    const fen = '8/8/8/4k3/8/8/7r/3QK3 b - - 0 1'
    expect(isZeroingAsDecisiveAsMate(fen, 'white')).toBe(true)

    const moves = [
      move('h2h4', 61, 51),
      move('h2g2', 45, 31),
      move('e5e4', 29, 13),
      move('h2b2', 21, 3),
      move('h2d2', 15, 1),
    ]
    const scale = decisiveDistanceScale(moves)
    expect(scale).toBe(123)

    const keys = moves.map((m) => decisiveDistance(m, true, scale)!)
    expect(keys.map((k) => Number(k.toFixed(3)))).toEqual([51.496, 31.366, 13.236, 3.171, 1.122])
    // strictly descending: the defender's preference order
    expect(keys.every((k, i) => i === 0 || keys[i - 1]! > k)).toBe(true)
    // the tiebreak never pushes a key out of its own integer step, so min(dtm, dtz) leads
    expect(keys.map((k) => Math.floor(k))).toEqual([51, 31, 13, 3, 1])
  })

  it('keeps a dtm tiebreak when dtz is constant (R+P on the 7th vs R)', () => {
    const fen = '1K6/1P6/8/7k/8/8/6r1/R7 b - - 0 1'
    expect(isZeroingAsDecisiveAsMate(fen, 'white')).toBe(true)

    const moves = [move('a', 33, 3), move('b', 32, 3), move('c', 31, 3)]
    const scale = decisiveDistanceScale(moves)
    expect(scale).toBe(67)
    const keys = moves.map((m) => Number(decisiveDistance(m, true, scale)!.toFixed(3)))
    expect(keys).toEqual([3.493, 3.478, 3.463])
  })

  it('rejects the pawn shape when a pawn is further back or the defender has one', () => {
    // pawn on the 6th, not one step from promoting
    expect(isZeroingAsDecisiveAsMate('1K6/8/1P6/7k/8/8/6r1/R7 b - - 0 1', 'white')).toBe(false)
    // two pawns, only one of them on the 7th
    expect(isZeroingAsDecisiveAsMate('1K6/1P6/2P5/7k/8/8/6r1/R7 b - - 0 1', 'white')).toBe(false)
    // defender has a pawn
    expect(isZeroingAsDecisiveAsMate('1K6/1P6/8/7k/8/5p2/6r1/R7 b - - 0 1', 'white')).toBe(false)
    // black winning: promotion rank is the 2nd
    expect(isZeroingAsDecisiveAsMate('1K6/8/8/7k/8/8/1p4r1/R7 b - - 0 1', 'black')).toBe(true)
    expect(isZeroingAsDecisiveAsMate('1K6/8/8/7k/8/1p6/6r1/R7 b - - 0 1', 'black')).toBe(false)
    // drawn position: no winner, so the metric is meaningless
    expect(isZeroingAsDecisiveAsMate('8/8/8/4k3/8/8/7r/3QK3 b - - 0 1', null)).toBe(false)
    // bare king: nothing to capture
    expect(isZeroingAsDecisiveAsMate('8/8/8/4k3/8/8/8/3QK3 b - - 0 1', 'white')).toBe(false)
  })

  it('falls back to dtm alone when zeroing is not decisive', () => {
    const moves = [move('a', 61, 51), move('b', 21, 3)]
    const scale = decisiveDistanceScale(moves)
    expect(moves.map((m) => decisiveDistance(m, false, scale))).toEqual([61, 21])
  })
})
