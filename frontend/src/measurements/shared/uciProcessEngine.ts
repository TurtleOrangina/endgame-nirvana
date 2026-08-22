import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { ref } from 'vue'
import type { EngineLine } from '@/types'
import type { StockfishEngine } from '@/composables/useStockfishEngine'
import { createUciSearchCollector } from '@/utils/uciSearchCollector'

// Node has no Web Worker, so the measurements drive a UCI engine as a child process
// speaking on stdio instead — behind the same `StockfishEngine` interface the app's move
// selection expects, so the measured code path is the shipped one. Used for both the
// native Stockfish binary and the bundled WASM build run under Node.
const DEFAULT_HASH_MB = 16

export interface UciProcessEngine extends StockfishEngine {
  quit(): void
  waitForReady(): Promise<void>
  /**
   * How many Syzygy WDL files the engine reported loading, or null if it never said. A
   * wrong `SyzygyPath` is not an error to Stockfish — it loads nothing and plays on — so
   * the count is kept for callers that need to verify the tables actually arrived.
   */
  loadedSyzygyFileCount(): number | null
}

// `info string Found 169 WDL and 169 DTZ tablebase files (up to 7-man).`
const SYZYGY_LOAD_REPORT = /Found (\d+) WDL/

export interface UciProcessEngineOptions {
  command: string
  args?: string[]
  threads: number
  hashMb?: number
  // Omitted → no `SyzygyPath` is sent, and the engine plays without tablebase knowledge
  syzygyPath?: string
}

interface QueuedSearch {
  fen: string
  moves: string[]
  lines: number
  thinkingTimeMs: number
  resolve: (lines: EngineLine[]) => void
  onProgress?: (lines: EngineLine[]) => void
}

export function createUciProcessEngine(options: UciProcessEngineOptions): UciProcessEngine {
  const isReady = ref(false)
  const isThinking = ref(false)
  const downloadProgress = ref(null)
  const collector = createUciSearchCollector()

  const process: ChildProcessWithoutNullStreams = spawn(options.command, options.args ?? [], {
    stdio: 'pipe',
  })
  const send = (command: string): void => void process.stdin.write(`${command}\n`)

  let resolveCurrentSearch: ((lines: EngineLine[]) => void) | null = null
  let onProgressCurrentSearch: ((lines: EngineLine[]) => void) | null = null
  let syzygyFileCount: number | null = null
  // The engine handles one search at a time, so overlapping callers queue up instead of
  // racing. The app's engine wrapper aborts the running search instead; the measurements
  // never issue concurrent searches, so waiting is both simpler and lossless.
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
    onProgressCurrentSearch = next.onProgress ?? null
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
      send(`setoption name Threads value ${options.threads}`)
      send(`setoption name Hash value ${options.hashMb ?? DEFAULT_HASH_MB}`)
      if (options.syzygyPath) send(`setoption name SyzygyPath value ${options.syzygyPath}`)
      send('isready')
    } else if (line === 'readyok') {
      isReady.value = true
      for (const resolve of readyResolvers) resolve()
      readyResolvers = []
    } else if (line.startsWith('info')) {
      const syzygyReport = SYZYGY_LOAD_REPORT.exec(line)
      if (syzygyReport) syzygyFileCount = Number(syzygyReport[1])
      if (resolveCurrentSearch) {
        const updatedLines = collector.consumeInfo(line)
        if (updatedLines) onProgressCurrentSearch?.(updatedLines)
      }
    } else if (line.startsWith('bestmove') && resolveCurrentSearch) {
      const resolve = resolveCurrentSearch
      resolveCurrentSearch = null
      onProgressCurrentSearch = null
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
    onProgress?: (lines: EngineLine[]) => void,
  ): Promise<EngineLine[]> {
    await waitForReady()
    return new Promise<EngineLine[]>((resolve) => {
      queue.push({ fen, moves, lines, thinkingTimeMs, resolve, onProgress })
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
    waitForReady,
    loadedSyzygyFileCount: () => syzygyFileCount,
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
