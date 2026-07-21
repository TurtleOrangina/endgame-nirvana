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

// Content-hashed directory the engine files are published under (see vite.config.ts).
// They are served immutable for a year, so a fix that changes how they must be loaded
// only reaches already-cached clients under a new path.
const ENGINE_BASE_PATH = __STOCKFISH_ENGINE_BASE_PATH__

// Watchdog for the engine's boot: the multi-threaded build's thread bootstrap can hang
// silently in the field (no error, just no readyok) in ways a fresh profile doesn't
// reproduce, and a worker script the browser refuses to load fails just as quietly.
// Every build is watched, because a fallback path with no watchdog of its own is a dead
// end the user cannot get out of by reloading.
const BOOT_WATCHDOG_TIMEOUT_MS = 15_000
const FORCE_SINGLE_THREADED_KEY = 'engineForceSingleThreadedUntil'
const FORCE_SINGLE_THREADED_TTL_MS = 24 * 60 * 60 * 1000

// The failover verdict is scoped to the build that reached it: a redeploy may well be
// the one fixing multi-threading, and must not inherit the old build's conclusion —
// especially since nothing but a successful multi-threaded boot clears the flag, and
// that boot is never attempted while it is set. Values from before this scoping existed
// were bare timestamps, which fail the build check and are ignored.
function isMultiThreadingBlockedByEarlierFailure(): boolean {
  try {
    const [buildId, expiresAt] = (localStorage.getItem(FORCE_SINGLE_THREADED_KEY) ?? '').split('|')
    if (buildId !== __APP_BUILD_ID__) return false
    return Date.now() < Number(expiresAt ?? 0)
  } catch {
    return false
  }
}

function setMultiThreadingBlocked(blocked: boolean): void {
  try {
    if (blocked) {
      localStorage.setItem(
        FORCE_SINGLE_THREADED_KEY,
        `${__APP_BUILD_ID__}|${Date.now() + FORCE_SINGLE_THREADED_TTL_MS}`,
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
  let forcedToSingleThreadedThisLoad = false
  // Last rung of the recovery ladder below, used at most once per page load
  let cacheBypassToken: number | null = null
  let bootWatchdog: ReturnType<typeof setTimeout> | undefined

  // (Re-)armed on boot and on every download-progress event, so a slow engine download
  // never counts against the timeout — only a silent post-download hang does.
  function armBootWatchdog(): void {
    if (isReady.value) return
    clearTimeout(bootWatchdog)
    bootWatchdog = setTimeout(recoverFromBootFailure, BOOT_WATCHDOG_TIMEOUT_MS)
  }

  function engineScriptUrl(): string {
    const file = usingMultiThreaded ? 'stockfish-18-lite.js' : 'stockfish-18-lite-single.js'
    // The engine assets are served immutable, so a stored response that the browser
    // won't accept as a worker script (e.g. one cached before the COOP/COEP headers
    // existed, which a cross-origin isolated page rejects) can only be got around by
    // requesting a URL that isn't in the cache under that key. The query string is
    // dropped when the engine derives its .wasm location from the script URL.
    const url = `${ENGINE_BASE_PATH}${file}`
    return cacheBypassToken === null ? url : `${url}?cache-bypass=${cacheBypassToken}`
  }

  // Ladder walked when the engine never reaches readyok: multi-threaded → single-threaded
  // → single-threaded from a cache-bypassing URL. Every rung must lead somewhere; a boot
  // failure with nowhere left to go used to leave the UI on "Loading engine…" forever,
  // across reloads and reinstalls, recoverable only by clearing site data by hand.
  function recoverFromBootFailure(): void {
    clearTimeout(bootWatchdog)
    worker.terminate()
    downloadProgress.value = null

    if (usingMultiThreaded) {
      console.warn(
        'Multi-threaded engine failed to become ready — restarting with the ' +
          'single-threaded build (and keeping it for up to 24h on this build).',
      )
      setMultiThreadingBlocked(true)
      forcedToSingleThreadedThisLoad = true
      startEngine()
      return
    }

    if (cacheBypassToken === null) {
      console.warn(
        'Single-threaded engine failed to become ready — retrying from a ' +
          'cache-bypassing URL in case the cached copy is unusable.',
      )
      cacheBypassToken = Date.now()
      startEngine()
      return
    }

    // Out of rungs. Drop the failover block so the next load starts over from the
    // multi-threaded build instead of going straight back to what just failed twice.
    console.error(
      'Engine failed to boot on every fallback path — the next load will retry from scratch.',
    )
    setMultiThreadingBlocked(false)
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
    usingMultiThreaded =
      supportsMultiThreading() &&
      !forcedToSingleThreadedThisLoad &&
      !isMultiThreadingBlockedByEarlierFailure()
    appliedThreads = null
    worker = new Worker(engineScriptUrl())
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
      // A crash (or a worker script the browser refused to load) before ready → take the
      // next rung now instead of waiting out the watchdog
      if (!isReady.value) {
        recoverFromBootFailure()
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
