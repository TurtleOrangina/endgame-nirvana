// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vite-plus/test'
import { openRunStore, runDetailPath, runHeaderFor, type RunHeader } from '../playoutRunStore'
import type { PlayoutPuzzle } from '../playoutPuzzleSelection'
import type { PuzzleMeasurement } from '../report'

const puzzles: PlayoutPuzzle[] = [
  { fen: 'first', categoryPath: '/x', goal: 'win', difficulty: 1500, men: 5 },
  { fen: 'second', categoryPath: '/x', goal: 'draw', difficulty: 1500, men: 8 },
]

function measurementFor(puzzle: PlayoutPuzzle): PuzzleMeasurement {
  return {
    puzzle,
    playouts: [
      {
        endReason: 'auto-win',
        delayMoves: 3,
        trickiness: 0.4,
        plies: [],
        moveTimesMs: [400],
        tablebaseLookupsPerMove: [1],
      },
    ],
  }
}

function header(overrides: Partial<RunHeader> = {}): RunHeader {
  return {
    ...runHeaderFor({
      defender: 'move-selector',
      puzzleSet: 'engine-playout-puzzles.yaml',
      seed: 1,
      playoutsPerPuzzle: 6,
      puzzles,
    }),
    ...overrides,
  }
}

function storePath(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'playout-run-')), 'run.jsonl')
}

describe('openRunStore', () => {
  test('appends a finished puzzle per line, behind the run configuration', () => {
    const filePath = storePath()
    const store = openRunStore(filePath, header(), false)
    store.append(measurementFor(puzzles[0]!))

    const [headerLine, row] = readFileSync(filePath, 'utf8').split('\n')
    expect(JSON.parse(headerLine!)).toMatchObject({ defender: 'move-selector', seed: 1 })
    expect((JSON.parse(row!) as PuzzleMeasurement).puzzle.fen).toBe('first')
    expect(store.completed).toEqual([])
  })

  test('hands back what an interrupted run finished', () => {
    const filePath = storePath()
    openRunStore(filePath, header(), false).append(measurementFor(puzzles[0]!))

    const resumed = openRunStore(filePath, header(), true)
    expect(resumed.completed.map((row) => row.puzzle.fen)).toEqual(['first'])

    // The resumed run keeps appending to the same file rather than starting it over
    resumed.append(measurementFor(puzzles[1]!))
    expect(openRunStore(filePath, header(), true).completed).toHaveLength(2)
  })

  test('starts over when not resuming, so a fresh run inherits no earlier rows', () => {
    const filePath = storePath()
    openRunStore(filePath, header(), false).append(measurementFor(puzzles[0]!))

    expect(openRunStore(filePath, header(), false).completed).toEqual([])
    expect(readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('refuses to continue a run measured under a different configuration', () => {
    const filePath = storePath()
    openRunStore(filePath, header(), false).append(measurementFor(puzzles[0]!))

    expect(() => openRunStore(filePath, header({ playoutsPerPuzzle: 2 }), true)).toThrow(
      /playoutsPerPuzzle 6 → 2/,
    )
    // A re-sampled puzzle set is caught by content, not just by its file name
    expect(() => openRunStore(filePath, header({ puzzleSetDigest: 'deadbeef' }), true)).toThrow(
      /puzzleSetDigest/,
    )
  })

  test('continues into a higher playout count, so a run can be topped up', () => {
    const filePath = storePath()
    openRunStore(filePath, header({ playoutsPerPuzzle: 3 }), false).append(
      measurementFor(puzzles[0]!),
    )

    const toppedUp = openRunStore(filePath, header({ playoutsPerPuzzle: 6 }), true)
    expect(toppedUp.completed.map((row) => row.puzzle.fen)).toEqual(['first'])
  })

  test('reads a puzzle topped up over two runs as one measurement', () => {
    const filePath = storePath()
    const store = openRunStore(filePath, header(), false)
    store.append(measurementFor(puzzles[0]!))
    // What a top-up appends: the additional playouts only, as their own row
    store.append(measurementFor(puzzles[0]!))
    store.append(measurementFor(puzzles[1]!))

    const completed = openRunStore(filePath, header(), true).completed
    expect(completed.map((row) => row.puzzle.fen)).toEqual(['first', 'second'])
    expect(completed[0]!.playouts).toHaveLength(2)
    expect(completed[1]!.playouts).toHaveLength(1)
  })

  test('drops a row left half-written by the interruption', () => {
    const filePath = storePath()
    const store = openRunStore(filePath, header(), false)
    store.append(measurementFor(puzzles[0]!))
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}{"puzzle":{"fen":"sec`)

    expect(openRunStore(filePath, header(), true).completed.map((row) => row.puzzle.fen)).toEqual([
      'first',
    ])
  })
})

describe('runDetailPath', () => {
  test('keeps each defender apart, out of the repo root and out of git', () => {
    expect(runDetailPath('/repo', 'engine-playout-baseline.yaml')).toBe(
      '/repo/.playout-runs/run.jsonl',
    )
    expect(runDetailPath('/repo', 'engine-playout-baseline-candidate.yaml')).toBe(
      '/repo/.playout-runs/run-candidate.jsonl',
    )
  })
})
