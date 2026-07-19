import { ref, type Ref } from 'vue'
import type { EngineLine } from '@/types'

// Thinking-time budgets for every kind of engine search, kept together so their
// relative sizes stay easy to compare.
export const DEFAULT_BEST_MOVE_THINKING_TIME_MS = 400
// Wide shallow searches probing the user's upcoming positions for the Trickster weighting
export const PROBE_THINKING_TIME_MS = 20
// Replying to a premove has to feel instant
export const PREMOVE_THINKING_TIME_MS = 50
// Second opinion before failing a puzzle (or trusting a zeroing move) on an
// engine-only verdict, when no authoritative tablebase answer is available
export const FAILURE_RECHECK_THINKING_TIME_MS = 400

// Physical core count isn't exposed by browsers; hardwareConcurrency reports logical
// cores, typically 2× physical with SMT — halving approximates the physical count.
// Capped so the engine never saturates the device (and the lite net gains little beyond).
const MAX_DEFAULT_THREADS = 8

export function defaultEngineThreads(): number {
  return Math.min(MAX_DEFAULT_THREADS, Math.max(1, Math.floor(navigator.hardwareConcurrency / 2)))
}

// SharedArrayBuffer only exists in cross-origin isolated contexts; without it the
// multi-threaded build cannot boot at all and the single-threaded fallback is used
export function supportsMultiThreading(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && crossOriginIsolated
}

// Watchdog for the multi-threaded build's boot: its thread bootstrap can hang silently
// in the field (no error, just no readyok) in ways a fresh profile doesn't reproduce.
// When it fires, the engine restarts with the single-threaded build, and that choice is
// remembered for a day so subsequent loads don't hang again before falling back.
const BOOT_WATCHDOG_TIMEOUT_MS = 15_000
const FORCE_SINGLE_THREADED_KEY = 'engineForceSingleThreadedUntil'
const FORCE_SINGLE_THREADED_TTL_MS = 24 * 60 * 60 * 1000

function isMultiThreadingBlockedByEarlierFailure(): boolean {
  try {
    return Date.now() < Number(localStorage.getItem(FORCE_SINGLE_THREADED_KEY) ?? 0)
  } catch {
    return false
  }
}

function setMultiThreadingBlocked(blocked: boolean): void {
  try {
    if (blocked) {
      localStorage.setItem(
        FORCE_SINGLE_THREADED_KEY,
        String(Date.now() + FORCE_SINGLE_THREADED_TTL_MS),
      )
    } else {
      localStorage.removeItem(FORCE_SINGLE_THREADED_KEY)
    }
  } catch {
    // Storage unavailable — the failover still works for this session
  }
}

export interface EngineDownloadProgress {
  percent: number
  loaded: number
  total: number
  speedText: string
  etaText: string
}

export interface StockfishEngine {
  isReady: Ref<boolean>
  isThinking: Ref<boolean>
  downloadProgress: Ref<EngineDownloadProgress | null>
  getBestMoves(
    fen: string,
    moves?: string[],
    thinkingTimeMs?: number,
    multipv?: number,
  ): Promise<EngineLine[]>
  getAnalysis(
    fen: string,
    lines: number,
    thinkingTimeMs: number,
    moves?: string[],
    onProgress?: (lines: EngineLine[]) => void,
  ): Promise<EngineLine[]>
  stopAnalysis(): void
  setThreadCount(threads: number): void
}

interface PendingSearch {
  fen: string
  moves: string[]
  lines: number
  thinkingTimeMs: number
  resolve: (lines: EngineLine[]) => void
  onProgress?: (lines: EngineLine[]) => void
}

let instance: StockfishEngine | null = null

function createEngine(): StockfishEngine {
  const isReady = ref(false)
  const isThinking = ref(false)
  const downloadProgress = ref<EngineDownloadProgress | null>(null)

  let resolveAnalysis: ((lines: EngineLine[]) => void) | null = null
  let onProgressCallback: ((lines: EngineLine[]) => void) | null = null
  // When true, we sent `stop` to abort a search and are waiting for its bestmove
  // before we can safely send the next position+go.
  let awaitingStopAck = false
  let pendingSearch: PendingSearch | null = null
  let analysisLines: Map<number, EngineLine> = new Map()
  let lastScoreCP: number | null = null
  let lastScoreMate: number | null = null

  // Assigned once startEngine() runs; every usage below happens only after `isReady`
  // becomes true, which can't happen before that.
  let worker!: Worker
  // Which build the current worker runs — decided per boot, since a watchdog failover
  // switches to the single-threaded build even when multi-threading is supported.
  let usingMultiThreaded = false
  let bootWatchdog: ReturnType<typeof setTimeout> | undefined

  // (Re-)armed on boot and on every download-progress event, so a slow engine download
  // never counts against the timeout — only a silent post-download hang does.
  function armBootWatchdog(): void {
    if (!usingMultiThreaded || isReady.value) return
    clearTimeout(bootWatchdog)
    bootWatchdog = setTimeout(failOverToSingleThreaded, BOOT_WATCHDOG_TIMEOUT_MS)
  }

  function failOverToSingleThreaded(): void {
    console.warn(
      'Multi-threaded engine failed to become ready — restarting with the ' +
        'single-threaded build (and keeping it for 24h).',
    )
    setMultiThreadingBlocked(true)
    clearTimeout(bootWatchdog)
    worker.terminate()
    downloadProgress.value = null
    startEngine()
  }

  // `setoption name Threads` rebuilds the engine's thread pool (spawning that many WASM
  // workers), so it must only be sent while no search is running, and re-sending an
  // unchanged value would rebuild the pool for nothing. The spawn cost is paid by the
  // next search — hence the warmup search below, which absorbs it at load time instead
  // of delaying the first real move of a puzzle.
  let requestedThreads = defaultEngineThreads()
  let appliedThreads: number | null = null

  const WARMUP_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

  // A throwaway search whose only purpose is carrying the pool rebuild that
  // launchSearch triggers for a pending thread-count change
  function runThreadPoolWarmup(): void {
    void getAnalysis(WARMUP_FEN, 1, 1)
  }

  function setThreadCount(threads: number): void {
    requestedThreads = Math.min(
      Math.max(1, Math.round(threads)),
      // The synced setting can come from a beefier device — never take this one's last
      // core, which stays reserved for the UI
      Math.max(1, navigator.hardwareConcurrency - 1),
    )
    // When idle, rebuild the pool right away so the change doesn't stall the next move
    const isIdle = isReady.value && !resolveAnalysis && !awaitingStopAck && !pendingSearch
    if (usingMultiThreaded && isIdle && appliedThreads !== requestedThreads) {
      runThreadPoolWarmup()
    }
  }

  function positionCommand(fen: string, moves: string[]): string {
    return moves.length > 0 ? `position fen ${fen} moves ${moves.join(' ')}` : `position fen ${fen}`
  }

  function launchSearch(ps: PendingSearch): void {
    if (usingMultiThreaded && appliedThreads !== requestedThreads) {
      worker.postMessage(`setoption name Threads value ${requestedThreads}`)
      appliedThreads = requestedThreads
    }
    isThinking.value = true
    analysisLines = new Map()
    lastScoreCP = null
    lastScoreMate = null
    resolveAnalysis = ps.resolve
    onProgressCallback = ps.onProgress ?? null
    worker.postMessage(`setoption name MultiPV value ${ps.lines}`)
    worker.postMessage(positionCommand(ps.fen, ps.moves))
    if (ps.thinkingTimeMs === Infinity) {
      worker.postMessage('go infinite')
    } else {
      worker.postMessage(`go movetime ${ps.thinkingTimeMs}`)
    }
  }

  function startEngine(): void {
    if (!supportsMultiThreading()) {
      console.warn(
        'Page is not cross-origin isolated (COOP/COEP headers missing, or stale cached ' +
          'app shell?) — falling back to the single-threaded engine.',
      )
    }
    usingMultiThreaded = supportsMultiThreading() && !isMultiThreadingBlockedByEarlierFailure()
    appliedThreads = null
    worker = new Worker(
      usingMultiThreaded ? '/engines/stockfish-18-lite.js' : '/engines/stockfish-18-lite-single.js',
    )
    armBootWatchdog()

    worker.onmessage = (event: MessageEvent<string>) => {
      const line = event.data
      if (line === 'uciok') {
        // Threads must be set before isready: readyok then only arrives once the whole
        // thread pool is spawned, so the first real search isn't stalled by it
        if (usingMultiThreaded) {
          worker.postMessage(`setoption name Threads value ${requestedThreads}`)
          appliedThreads = requestedThreads
        }
        worker.postMessage('isready')
      } else if (line === 'readyok') {
        clearTimeout(bootWatchdog)
        // A multi-threaded boot succeeded — lift any earlier failover block
        if (usingMultiThreaded) setMultiThreadingBlocked(false)
        isReady.value = true
        downloadProgress.value = null
      } else if (line.startsWith('info')) {
        // Ignore info lines while waiting for the stop acknowledgement —
        // they belong to the search we just aborted.
        if (!resolveAnalysis || awaitingStopAck) return
        // Fail-high/fail-low re-search lines report a transient bound, not a real
        // evaluation, and their truncated pv would clobber a complete earlier line
        // at the same or lower depth.
        if (/ score (cp|mate) -?\d+ (upper|lower)bound/.test(line)) return

        const cpMatch = line.match(/score cp (-?\d+)/)
        const mateMatch = line.match(/score mate (-?\d+)/)
        const multipvMatch = line.match(/multipv (\d+)/)
        const depthMatch = line.match(/depth (\d+)/)
        const pvMatch = line.match(/ pv (.+)$/)

        const lineScoreCP = cpMatch ? parseInt(cpMatch[1] ?? '0') : null
        const lineScoreMate = mateMatch ? parseInt(mateMatch[1] ?? '0') : null

        // Only the best line's score may become the position's evaluation — with
        // MultiPV > 1 the later lines are deliberately worse moves, and letting them
        // overwrite the score would misreport the position (e.g. a winning position
        // looking drawn because the third-best move only keeps a small edge).
        const isBestLine = !multipvMatch || multipvMatch[1] === '1'
        if (isBestLine && (cpMatch || mateMatch)) {
          lastScoreCP = lineScoreCP
          lastScoreMate = lineScoreMate
        }

        if (multipvMatch && pvMatch) {
          const multipvIndex = parseInt(multipvMatch[1] ?? '1')
          const depth = depthMatch ? parseInt(depthMatch[1] ?? '0') : 0
          const moves = pvMatch[1]?.trim().split(' ') ?? []
          const existing = analysisLines.get(multipvIndex)
          if (!existing || depth >= existing.depth) {
            analysisLines.set(multipvIndex, {
              moves,
              scoreCP: lineScoreCP,
              scoreMate: lineScoreMate,
              depth,
              multipvIndex,
            })
            onProgressCallback?.(
              [...analysisLines.values()].sort((a, b) => a.multipvIndex - b.multipvIndex),
            )
          }
        }
      } else if (line.startsWith('bestmove')) {
        if (awaitingStopAck) {
          // Engine has fully stopped — now safe to send new commands.
          awaitingStopAck = false
          if (pendingSearch) {
            const ps = pendingSearch
            pendingSearch = null
            launchSearch(ps)
          } else {
            isThinking.value = false
          }
        } else if (resolveAnalysis) {
          let result = [...analysisLines.values()].sort((a, b) => a.multipvIndex - b.multipvIndex)
          // Extremely fast trivial searches can in theory emit a bestmove without any
          // pv info lines — synthesize a single line from the bestmove token so callers
          // still get a move. `bestmove (none)` (terminal position) stays an empty result.
          if (result.length === 0) {
            const move = line.split(' ')[1]
            if (move && move !== '(none)') {
              result = [
                {
                  moves: [move],
                  scoreCP: lastScoreCP,
                  scoreMate: lastScoreMate,
                  depth: 0,
                  multipvIndex: 1,
                },
              ]
            }
          }
          worker.postMessage('setoption name MultiPV value 1')
          resolveAnalysis(result)
          resolveAnalysis = null
          onProgressCallback = null
          analysisLines = new Map()
          lastScoreCP = null
          lastScoreMate = null
          isThinking.value = false
        }
      }
    }

    worker.onerror = () => {
      // A crash before ready on the multi-threaded build → try the single build now
      // instead of waiting for the watchdog
      if (!isReady.value && usingMultiThreaded) {
        failOverToSingleThreaded()
        return
      }
      resolveAnalysis?.([])
      resolveAnalysis = null
      pendingSearch?.resolve([])
      pendingSearch = null
      onProgressCallback = null
      awaitingStopAck = false
      isThinking.value = false
    }

    const progressChannel = new MessageChannel()
    progressChannel.port1.onmessage = (event: MessageEvent<EngineDownloadProgress>) => {
      if (!isReady.value) downloadProgress.value = event.data
      armBootWatchdog()
    }
    worker.postMessage({ progressPort: progressChannel.port2 }, [progressChannel.port2])
    worker.postMessage('setoption name CanOutputEngineDownloadProgress')
    worker.postMessage('uci')
  }

  // Defers the ~7 MB engine download until the browser is idle, so it doesn't
  // compete for bandwidth/connections with the board, pieces, and exercise data
  // that need to render first.
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(startEngine, { timeout: 2000 })
  } else {
    setTimeout(startEngine, 0)
  }

  function waitForReady(): Promise<void> {
    if (isReady.value) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (isReady.value) {
          clearInterval(interval)
          resolve()
        }
      }, 50)
    })
  }

  function getBestMoves(
    fen: string,
    moves: string[] = [],
    thinkingTimeMs: number = DEFAULT_BEST_MOVE_THINKING_TIME_MS,
    multipv = 1,
  ): Promise<EngineLine[]> {
    return getAnalysis(fen, multipv, thinkingTimeMs, moves)
  }

  async function getAnalysis(
    fen: string,
    lines: number,
    thinkingTimeMs: number,
    moves: string[] = [],
    onProgress?: (lines: EngineLine[]) => void,
  ): Promise<EngineLine[]> {
    await waitForReady()

    if (resolveAnalysis || awaitingStopAck) {
      // A search is running (or we already sent stop and are waiting for its ack).
      // Send stop only once — if awaitingStopAck is already true we've already sent it.
      if (!awaitingStopAck) {
        awaitingStopAck = true
        onProgressCallback = null
        resolveAnalysis?.([])
        resolveAnalysis = null
        worker.postMessage('stop')
      }
      // Cancel any previously queued (but not yet started) search.
      pendingSearch?.resolve([])
      // Queue this search to start once the stop ack arrives.
      return new Promise<EngineLine[]>((resolve) => {
        pendingSearch = { fen, moves, lines, thinkingTimeMs, resolve, onProgress }
      })
    }

    // No ongoing search — start immediately.
    return new Promise<EngineLine[]>((resolve) => {
      launchSearch({ fen, moves, lines, thinkingTimeMs, resolve, onProgress })
    })
  }

  function stopAnalysis(): void {
    pendingSearch?.resolve([])
    pendingSearch = null
    if (resolveAnalysis && !awaitingStopAck) {
      awaitingStopAck = true
      onProgressCallback = null
      resolveAnalysis([])
      resolveAnalysis = null
      worker.postMessage('stop')
    }
  }

  return {
    isReady,
    isThinking,
    downloadProgress,
    getBestMoves,
    getAnalysis,
    stopAnalysis,
    setThreadCount,
  }
}

export function useStockfishEngine(): StockfishEngine {
  instance ??= createEngine()
  return instance
}
