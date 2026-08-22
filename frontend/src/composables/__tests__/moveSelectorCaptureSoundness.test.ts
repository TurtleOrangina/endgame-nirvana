import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { Chess } from 'chess.js'
import { ref } from 'vue'
import { PRODUCTION_TUNING, useMoveSelector } from '@/composables/useMoveSelector'
import type { StockfishEngine } from '@/composables/useStockfishEngine'
import type { EngineLine } from '@/types'

// White is lost (king and a pawn against the queen) and has three king moves. Two of them
// keep the f7 pawn defended, so the user's Qxf7 hangs the queen and the recapture leaves a
// dead draw; only after Kg5 does Qxf7 really win the pawn and reduce the position to
// king-and-queen against a bare king. The line probe sees the same king-vs-queen frame in
// all three, one ply after the capture — telling them apart is what the soundness check is
// for. Reported from a real game, where all three came out at dtd 2 and the delayer, left
// with nothing to separate them, weighted the immediately losing Kg5 like the other two.
const FEN = '8/5P2/3k1K2/8/8/5q2/8/8 w - - 3 3'

const TABLEBASE_MOVES = [
  { uci: 'f6g7', san: 'Kg7', dtz: 3, dtm: 11 },
  { uci: 'f6g6', san: 'Kg6', dtz: 3, dtm: 11 },
  { uci: 'f6g5', san: 'Kg5', dtz: 1, dtm: 11 },
]

function tablebasePayload(): string {
  return JSON.stringify({
    category: 'loss',
    moves: TABLEBASE_MOVES.map((move) => ({
      ...move,
      category: 'win',
      zeroing: false,
      conversion: false,
      checkmate: false,
      stalemate: false,
      insufficient_material: false,
      precise_dtz: null,
      dtw: null,
      dtc: null,
    })),
  })
}

// One king move each and nothing after it: what the probe finds is then entirely the
// user's own capture, which is the branch under test.
function candidateLines(): EngineLine[] {
  return TABLEBASE_MOVES.map((move, index) => ({
    moves: [move.uci],
    scoreCP: null,
    scoreMate: -6,
    depth: 25,
    multipvIndex: index + 1,
  }))
}

// Stands in for the engine's verdict on a position the user just captured into: level when
// the capture can be answered by taking the piece back, hopeless for white when it cannot.
function soundnessLine(fen: string): EngineLine {
  const position = new Chess(fen)
  const canRecapture = position.moves({ verbose: true }).some((move) => move.isCapture())
  return {
    moves: [],
    scoreCP: canRecapture ? 0 : -900,
    scoreMate: null,
    depth: 12,
    multipvIndex: 1,
  }
}

// Reports through onProgress and resolves with nothing once stopped, exactly as the real
// engine does when the capture probe cuts a search short. `onSoundnessSearch` lets a test
// charge each of those searches to the fake clock below.
function createStubEngine(onSoundnessSearch: () => void = () => {}): StockfishEngine {
  let stopped = false
  return {
    isReady: ref(true),
    isThinking: ref(false),
    downloadProgress: ref(null),
    getBestMoves: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(candidateLines()), 10)
      }),
    getAnalysis: (fen, _lines, _thinkingTimeMs, _moves, onProgress) => {
      onSoundnessSearch()
      stopped = false
      onProgress?.([soundnessLine(fen)])
      return Promise.resolve(stopped ? [] : [soundnessLine(fen)])
    },
    stopAnalysis: () => {
      stopped = true
    },
    setThreadCount: () => {},
  }
}

interface LoggedCandidate {
  san: string
  delayerWeight: number
  dtd: number
  reason: string
}

// `  * Kg6  44.4% w_delayer= 44.4% w_trickster=   n/a (fault_potential=..., dtd=12 [...])`
function parseLoggedCandidates(logged: string[]): Map<string, LoggedCandidate> {
  const candidates = logged.flatMap((line) => {
    const match =
      /^\s+\*?\s+(\S+)\s+[\d.]+% w_delayer=\s*([\d.]+)%.*dtd=([\d.]+) \[([^\]]+)\]/.exec(line)
    return match
      ? [
          {
            san: match[1]!,
            delayerWeight: Number(match[2]),
            dtd: Number(match[3]),
            reason: match[4]!,
          },
        ]
      : []
  })
  return new Map(candidates.map((candidate) => [candidate.san, candidate]))
}

describe('move selector capture soundness', () => {
  let logged: string[]

  beforeEach(() => {
    logged = []
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '))
    })
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(tablebasePayload(), { status: 200 })))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('only counts a capture into a done position when the capture holds up', async () => {
    // The Trickster is off so the logged weights are the delayer's alone — its inability to
    // separate these three moves is what the fix is about.
    const { getBestMove } = useMoveSelector(createStubEngine(), {
      ...PRODUCTION_TUNING,
      trickster: false,
    })
    await getBestMove(FEN, [], FEN, {
      temperature: 0.2,
      isPremove: false,
      playerColor: 'black',
      queryTablebase: true,
    })

    const byMove = parseLoggedCandidates(logged)
    expect([...byMove.keys()].sort()).toEqual(['Kg5', 'Kg6', 'Kg7'])

    // Kg5 really does hang the pawn: Qxf7 is unanswerable and ends the game as a formality
    expect(byMove.get('Kg5')!.dtd).toBe(2)
    expect(byMove.get('Kg5')!.reason).toBe('LineProbe Capture into King vs Major')
    // Kg6/Kg7 defend it, so their Qxf7 is refuted and must not shorten their distance
    expect(byMove.get('Kg6')!.dtd).toBeGreaterThan(2)
    expect(byMove.get('Kg7')!.dtd).toBeGreaterThan(2)

    expect(byMove.get('Kg5')!.delayerWeight).toBeLessThan(byMove.get('Kg6')!.delayerWeight)
  })

  it('stops verifying captures once the selection has taken too long', async () => {
    // Every candidate offers a capture to check, and here each check is made to cost more
    // than a third of the budget. The candidates are searched in the engine's own order —
    // Kg7, Kg6, then Kg5 — so the clock runs out on Kg5, whose capture is the sound one.
    let fakeNow = 0
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow)
    const chargePerSearch = 600

    const { getBestMove } = useMoveSelector(
      createStubEngine(() => {
        fakeNow += chargePerSearch
      }),
      { ...PRODUCTION_TUNING, trickster: false },
    )
    await getBestMove(FEN, [], FEN, {
      temperature: 0.2,
      isPremove: false,
      playerColor: 'black',
      queryTablebase: true,
    })

    // Unverified, so not counted as done — the same reading the probe had before it could
    // check at all, rather than a guess in either direction
    const byMove = parseLoggedCandidates(logged)
    expect(byMove.get('Kg5')!.dtd).toBeGreaterThan(2)
    expect(byMove.get('Kg5')!.reason).not.toContain('Capture into')
    // Two searches ran before the budget was spent; nothing kept spending after it
    expect(fakeNow).toBe(2 * chargePerSearch)
  })
})
