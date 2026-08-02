import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { ref } from 'vue'
import type { EngineLine } from '@/types'
import type { StockfishEngine } from '@/composables/useStockfishEngine'
import { createUciSearchCollector } from '@/utils/uciSearchCollector'

// Node has no Web Worker and no WASM engine build, so the measurement drives the native
// Stockfish binary instead, through the same `StockfishEngine` interface the app's move
// selection expects. Two deliberate differences from the browser engine, both of which
// keep the measured position *harder* to reproduce rather than easier:
//   - the native build uses the full NNUE net, the app ships the "lite" one, so the
//     engine lines here are marginally stronger than what a user actually faces
//   - no SyzygyPath is configured: the app's engine has no tablebase access either, and
//     handing this one perfect endgame knowledge would measure a different opponent
export const NATIVE_STOCKFISH_PATH = '/home/node/native_stockfish/engines/stockfish_latest'

// Matches the browser default (`defaultEngineThreads`) on a typical 8-core machine.
// The Trickster's probe searches are only 20ms, so a much larger pool would spend most
// of that budget on thread synchronization rather than on searching.
const DEFAULT_THREADS = 4
const DEFAULT_HASH_MB = 16

export interface NativeStockfishEngine extends StockfishEngine {
  quit(): void
}

interface QueuedSearch {
  fen: string
  moves: string[]
  lines: number
  thinkingTimeMs: number
  resolve: (lines: EngineLine[]) => void
}

export function createNativeStockfishEngine(
  binaryPath: string = NATIVE_STOCKFISH_PATH,
  threads: number = DEFAULT_THREADS,
): NativeStockfishEngine {
  const isReady = ref(false)
  const isThinking = ref(false)
  const downloadProgress = ref(null)
  const collector = createUciSearchCollector()

  const process: ChildProcessWithoutNullStreams = spawn(binaryPath, [], { stdio: 'pipe' })
  const send = (command: string): void => void process.stdin.write(`${command}\n`)

  let resolveCurrentSearch: ((lines: EngineLine[]) => void) | null = null
  // The binary handles one search at a time, so overlapping callers queue up instead of
  // racing. The app's engine wrapper aborts the running search instead; the measurement
  // never issues concurrent searches, so waiting is both simpler and lossless.
  const queue: QueuedSearch[] = []
  let readyResolvers: Array<() => void> = []

  function startNextSearch(): void {
    const next = queue.shift()
    if (!next) {
      isThinking.value = false
      return
    }
    isThinking.value = true
    collector.reset()
    resolveCurrentSearch = next.resolve
    send(`setoption name MultiPV value ${next.lines}`)
    send(
      next.moves.length > 0
        ? `position fen ${next.fen} moves ${next.moves.join(' ')}`
        : `position fen ${next.fen}`,
    )
    send(`go movetime ${next.thinkingTimeMs}`)
  }

  createInterface({ input: process.stdout }).on('line', (line: string) => {
    if (line === 'uciok') {
      send(`setoption name Threads value ${threads}`)
      send(`setoption name Hash value ${DEFAULT_HASH_MB}`)
      send('isready')
    } else if (line === 'readyok') {
      isReady.value = true
      for (const resolve of readyResolvers) resolve()
      readyResolvers = []
    } else if (line.startsWith('info')) {
      if (resolveCurrentSearch) collector.consumeInfo(line)
    } else if (line.startsWith('bestmove') && resolveCurrentSearch) {
      const resolve = resolveCurrentSearch
      resolveCurrentSearch = null
      resolve(collector.finish(line))
      collector.reset()
      startNextSearch()
    }
  })

  send('uci')

  function waitForReady(): Promise<void> {
    if (isReady.value) return Promise.resolve()
    return new Promise<void>((resolve) => readyResolvers.push(resolve))
  }

  async function getAnalysis(
    fen: string,
    lines: number,
    thinkingTimeMs: number,
    moves: string[] = [],
  ): Promise<EngineLine[]> {
    await waitForReady()
    return new Promise<EngineLine[]>((resolve) => {
      queue.push({ fen, moves, lines, thinkingTimeMs, resolve })
      if (!resolveCurrentSearch) startNextSearch()
    })
  }

  return {
    isReady,
    isThinking,
    downloadProgress,
    getBestMoves: (fen, moves = [], thinkingTimeMs = 400, multipv = 1) =>
      getAnalysis(fen, multipv, thinkingTimeMs, moves),
    getAnalysis,
    stopAnalysis: () => send('stop'),
    setThreadCount: () => {
      // Fixed for the whole measurement — a mid-run pool rebuild would only add noise
    },
    quit: () => {
      send('quit')
      process.kill()
    },
  }
}
