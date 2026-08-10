import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import { ref } from 'vue'
import { useMoveSelector } from '@/composables/useMoveSelector'
import type { StockfishEngine } from '@/composables/useStockfishEngine'
import type { EngineLine } from '@/types'

// A pawnless KQ vs KR position, used as a fixture for the delayer path. The five moves and
// their dtz/dtm pairs are real values from the live Lichess tablebase for this FEN, but the
// stubbed verdict below deliberately drops the position's actual best move (Rh1+, which wins
// the queen and holds a draw): with it, candidate filtering would leave a single move and
// getBestMove would return early, never reaching the distance seeding under test. What the
// FEN itself still supplies is move legality, the material counts behind
// isZeroingAsDecisiveAsMate, and the LineProbe's capture detection.
const FEN = '8/8/8/4k3/8/8/7r/3QK3 b - - 0 1'

const TABLEBASE_MOVES = [
  { uci: 'h2h4', san: 'Rh4', dtz: 51, dtm: 61 },
  { uci: 'h2g2', san: 'Rg2', dtz: 31, dtm: 45 },
  { uci: 'e5e4', san: 'Ke4', dtz: 13, dtm: 29 },
  { uci: 'h2b2', san: 'Rb2', dtz: 3, dtm: 21 },
  { uci: 'h2d2', san: 'Rd2', dtz: 1, dtm: 15 },
]

// Category 'win' is the resulting position from white's perspective, i.e. black is losing
// whatever it plays — the delayer path the dtz seeding is meant to improve.
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

function engineLines(): EngineLine[] {
  return TABLEBASE_MOVES.map((move, index) => ({
    moves: [move.uci],
    scoreCP: null,
    scoreMate: Math.ceil(move.dtm / 2),
    depth: 30,
    multipvIndex: index + 1,
  }))
}

function createStubEngine(): StockfishEngine {
  return {
    isReady: ref(true),
    isThinking: ref(false),
    downloadProgress: ref(null),
    // Yields to the macrotask queue so the tablebase fetch (which the selector fires
    // without awaiting) has landed by the time the "search" resolves, exactly as it does
    // against the real engine's search time.
    getBestMoves: () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(engineLines()), 10)
      }),
    getAnalysis: () => Promise.resolve([]),
    stopAnalysis: () => {},
    setThreadCount: () => {},
  }
}

interface LoggedCandidate {
  san: string
  weight: number
  dtd: number
  reason: string
}

// The selector logs one line per candidate, ordered by descending weight:
//     * Rh4  71.3% w_delayer= 71.3% w_trickster=   n/a (fault_potential=..., dtd=52.5 [...])
function parseLoggedCandidates(logged: string[]): LoggedCandidate[] {
  return logged.flatMap((line) => {
    const match = /^\s+\*?\s+(\S+)\s+([\d.]+)%.*dtd=([\d.]+) \[([^\]]+)\]/.exec(line)
    return match
      ? [
          {
            san: match[1]!,
            weight: Number(match[2]),
            dtd: Number(match[3]),
            reason: match[4]!,
          },
        ]
      : []
  })
}

describe('move selector tablebase distances', () => {
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

  it('seeds dtd from min(dtm, dtz) and does not let the clamp undo it', async () => {
    const { getBestMove } = useMoveSelector(createStubEngine())
    const selection = await getBestMove(FEN, [], FEN, {
      temperature: 0.33,
      isPremove: false,
      playerColor: 'white',
      queryTablebase: true,
    })

    expect(selection.bestmove).not.toBeNull()
    const candidates = parseLoggedCandidates(logged)
    expect(candidates.map((c) => c.san).sort()).toEqual(['Ke4', 'Rb2', 'Rd2', 'Rg2', 'Rh4'])

    const byMove = new Map(candidates.map((c) => [c.san, c]))
    // Tablebase-seeded: min(dtz, dtm) + max/(2*61+1), plus one for the move itself
    expect(byMove.get('Rh4')!.dtd).toBeCloseTo(52.5, 1)
    expect(byMove.get('Rg2')!.dtd).toBeCloseTo(32.37, 1)
    expect(byMove.get('Ke4')!.dtd).toBeCloseTo(14.24, 1)
    // Rb2 keeps a dtm of 21 but hands over the rook in 3 plies — under a dtm-only seed it
    // would have scored 22, nearly as resistant as Ke4
    expect(byMove.get('Rb2')!.dtd).toBeCloseTo(4.17, 1)
    expect(byMove.get('Rb2')!.reason).toBe('tablebase min(dtm,dtz)')

    // The clamp must not floor the piece-dropping defenses back up to the dtm ordering
    expect(candidates.every((c) => c.reason !== 'tablebase ordering')).toBe(true)

    // Rh4 resists longest, so the delayer must weight it highest
    expect(candidates[0]!.san).toBe('Rh4')
    expect(byMove.get('Rh4')!.weight).toBeGreaterThan(byMove.get('Rb2')!.weight)
  })

  it('falls back to dtm alone when a pawn makes zeroing non-decisive', async () => {
    // Same geometry plus a defending black pawn, which disqualifies the zeroing metric
    const pawnFen = '8/8/8/4k3/8/5p2/7r/3QK3 b - - 0 1'
    const { getBestMove } = useMoveSelector(createStubEngine())
    await getBestMove(pawnFen, [], pawnFen, {
      temperature: 0.33,
      isPremove: false,
      playerColor: 'white',
      queryTablebase: true,
    })

    const byMove = new Map(parseLoggedCandidates(logged).map((c) => [c.san, c]))
    expect(byMove.get('Rh4')!.reason).toBe('tablebase dtm')
    expect(byMove.get('Rh4')!.dtd).toBeCloseTo(62, 1)
  })
})
