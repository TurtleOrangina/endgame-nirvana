import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ref } from 'vue'
import {
  PRODUCTION_TUNING,
  useMoveSelector,
  type SelectorTuning,
} from '@/composables/useMoveSelector'
import type { StockfishEngine } from '@/composables/useStockfishEngine'
import type { EngineLine } from '@/types'

// White is lost against the queen and has a pawn on the board, so the loss plan runs the
// Trickster (it sits out pawnless lost positions). The white king can shuttle f1/g1 safely
// while the black queen wanders, which is what lets one candidate carry a long PV.
const FEN = '8/8/8/3q4/8/k7/7P/6K1 w - - 0 1'

// Two candidates that differ *only* in how far their PV happens to run — five user-to-move
// positions against one. Nothing about the position says the first is trickier; the search
// simply looked further down it.
const LONG_PV = ['g1f1', 'd5d6', 'f1g1', 'd6d7', 'g1f1', 'd7d8', 'f1g1', 'd8e8', 'g1f1', 'e8e7']
const SHORT_PV = ['g1f2']

function candidateLines(): EngineLine[] {
  return [LONG_PV, SHORT_PV].map((moves, index) => ({
    moves,
    scoreCP: -900,
    scoreMate: null,
    depth: 20,
    multipvIndex: index + 1,
  }))
}

// Every probed position answers the same way: nothing the user plays holds the win, which
// engineMaintainFraction floors at its minimum maintain fraction. So each probe contributes an
// identical factor and the only thing separating the two lines is how many there were.
function probeLines(): EngineLine[] {
  return ['a3b3', 'a3a4', 'a3b2'].map((uci, index) => ({
    moves: [uci],
    scoreCP: 0,
    scoreMate: null,
    depth: 10,
    multipvIndex: index + 1,
  }))
}

function createStubEngine(): StockfishEngine {
  return {
    isReady: ref(true),
    isThinking: ref(false),
    downloadProgress: ref(null),
    getBestMoves: (_fen, _moves, _thinkingTimeMs, multipv) =>
      Promise.resolve(multipv === 5 ? candidateLines() : probeLines()),
    getAnalysis: () => Promise.resolve([]),
    stopAnalysis: () => {},
    setThreadCount: () => {},
  }
}

// `  * Kf1  62.0% w_delayer= 50.0% w_trickster= 74.1% (fault_potential= ...`
function loggedTricksterWeights(logged: string[]): Map<string, number> {
  const weights = new Map<string, number>()
  for (const line of logged) {
    const match = /^\s+\*?\s+(\S+)\s+[\d.]+%.*w_trickster=\s*([\d.]+)%/.exec(line)
    if (match) weights.set(match[1]!, Number(match[2]))
  }
  return weights
}

async function tricksterWeightsWith(
  tricksterAggregation: SelectorTuning['tricksterAggregation'],
): Promise<Map<string, number>> {
  const logged: string[] = []
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  })
  const { getBestMove } = useMoveSelector(createStubEngine(), {
    ...PRODUCTION_TUNING,
    tricksterAggregation,
  })
  await getBestMove(FEN, [], FEN, {
    temperature: 0.2,
    isPremove: false,
    playerColor: 'black',
    queryTablebase: false,
  })
  return loggedTricksterWeights(logged)
}

describe('trickster probe aggregation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no tablebase in this test')))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rates the longer-searched line trickier when the probes are multiplied', async () => {
    const weights = await tricksterWeightsWith('product')
    // Kf1 was probed five times and Kf2 once, at identical survival each time, so the
    // product punishes Kf1 five-fold for something the position never said
    expect(weights.get('Kf1')!).toBeGreaterThan(weights.get('Kf2')! * 5)
  })

  it('rates them equally once the probes are averaged', async () => {
    const weights = await tricksterWeightsWith('geometric-mean')
    expect(weights.get('Kf1')!).toBeCloseTo(weights.get('Kf2')!, 1)
  })
})

describe('focused trickster probing', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no tablebase in this test')))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  // Probing fewer candidates is only worth doing if the saved search goes back into the
  // ones that remain — otherwise it is just a weaker Trickster
  it('spends the same total probe time on fewer, longer-searched candidates', async () => {
    const probeTimes: Record<string, number[]> = { all: [], focused: [] }
    for (const [label, tricksterProbedCandidates] of [
      ['all', null],
      ['focused', 1],
    ] as const) {
      const engine: StockfishEngine = {
        isReady: ref(true),
        isThinking: ref(false),
        downloadProgress: ref(null),
        getBestMoves: (_fen, _moves, thinkingTimeMs, multipv) => {
          if (multipv === 5) return Promise.resolve(candidateLines())
          probeTimes[label]!.push(thinkingTimeMs ?? 0)
          return Promise.resolve(probeLines())
        },
        getAnalysis: () => Promise.resolve([]),
        stopAnalysis: () => {},
        setThreadCount: () => {},
      }
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const { getBestMove } = useMoveSelector(engine, {
        ...PRODUCTION_TUNING,
        tricksterProbedCandidates,
      })
      await getBestMove(FEN, [], FEN, {
        temperature: 0.2,
        isPremove: false,
        playerColor: 'black',
        queryTablebase: false,
      })
    }

    const total = (times: number[]): number => times.reduce((sum, value) => sum + value, 0)
    expect(probeTimes.focused!.length).toBeLessThan(probeTimes.all!.length)
    expect(Math.max(...probeTimes.focused!)).toBeGreaterThan(Math.max(...probeTimes.all!))
    // Equal budget, up to the rounding of a per-probe millisecond count
    expect(total(probeTimes.focused!) / total(probeTimes.all!)).toBeCloseTo(1, 1)
  })
})
