// @vitest-environment node
import { describe, expect, test } from 'vite-plus/test'
import { createSeededRandom, shuffled } from '@/measurements/shared/puzzleCatalog'
import { formatDuration, formatEtaLine } from '../runEnginePlayout'

describe('formatDuration', () => {
  test.each([
    [0, '0s'],
    [45_000, '45s'],
    [372_000, '6min'],
    [2_700_000, '45min'],
    [3_600_000, '1h00min'],
    [5_460_000, '1h31min'],
  ])('formats %ims as %s', (milliseconds, expected) => {
    expect(formatDuration(milliseconds)).toBe(expected)
  })
})

describe('formatEtaLine', () => {
  const at = (hours: number, minutes: number): Date => new Date(2026, 7, 11, hours, minutes)

  test('extrapolates the finish time from the pace so far', () => {
    // A quarter done after 15 minutes → 45 minutes left, so 45 minutes past 20:45
    expect(formatEtaLine(30, 120, 15 * 60_000, at(20, 45))).toBe('25% done, ETA: 21:30 (45min)')
  })

  test('rolls the clock past midnight rather than wrapping the hour', () => {
    expect(formatEtaLine(60, 120, 90 * 60_000, at(23, 30))).toBe('50% done, ETA: 01:00 (1h30min)')
  })

  test('stops projecting once every puzzle is done', () => {
    expect(formatEtaLine(120, 120, 60 * 60_000, at(21, 30))).toBe('100% done, finished at 21:30')
  })
})

describe('processing order', () => {
  const puzzles = Array.from({ length: 120 }, (_, index) => ({ index }))

  test('visits every puzzle exactly once, in a different order than the file', () => {
    const order = shuffled(
      puzzles.map((puzzle, index) => ({ puzzle, index })),
      createSeededRandom(20260809 + 104_729),
    )
    expect(order).toHaveLength(puzzles.length)
    expect(order.map((entry) => entry.index).sort((a, b) => a - b)).toEqual(
      puzzles.map((_, index) => index),
    )
    expect(order.map((entry) => entry.index)).not.toEqual(puzzles.map((_, index) => index))
  })

  test('writing results into their original slots undoes the shuffle', () => {
    const order = shuffled(
      puzzles.map((puzzle, index) => ({ puzzle, index })),
      createSeededRandom(20260809 + 104_729),
    )
    const byIndex = Array.from<{ index: number } | undefined>({ length: puzzles.length })
    for (const { puzzle, index } of order) byIndex[index] = puzzle
    expect(byIndex.filter((entry) => entry !== undefined)).toEqual(puzzles)
  })

  test('is reproducible for a given seed and changes with it', () => {
    const orderFor = (seed: number): number[] =>
      shuffled(
        puzzles.map((puzzle, index) => ({ puzzle, index })),
        createSeededRandom(seed),
      ).map((entry) => entry.index)
    expect(orderFor(1)).toEqual(orderFor(1))
    expect(orderFor(1)).not.toEqual(orderFor(2))
  })
})
