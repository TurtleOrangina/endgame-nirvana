import { ref, type Ref } from 'vue'
import type { EngineEvaluation, EngineLine } from '@/types'

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
  getBestMove(fen: string, moves?: string[], thinkingTimeMs?: number): Promise<EngineEvaluation>
  getAnalysis(
    fen: string,
    lines: number,
    thinkingTimeMs: number,
    moves?: string[],
    onProgress?: (lines: EngineLine[]) => void,
  ): Promise<EngineLine[]>
  stopAnalysis(): void
}

interface PendingSearch {
  fen: string
  moves: string[]
  lines: number
  thinkingTimeMs: number
  resolve: (lines: EngineLine[]) => void
  onProgress?: (lines: EngineLine[]) => void
}

const DEFAULT_BEST_MOVE_THINKING_TIME_MS = 400

interface PendingBestMove {
  fen: string
  moves: string[]
  thinkingTimeMs: number
  resolve: (eval_: EngineEvaluation) => void
}

let instance: StockfishEngine | null = null

function createEngine(): StockfishEngine {
  const isReady = ref(false)
  const isThinking = ref(false)
  const downloadProgress = ref<EngineDownloadProgress | null>(null)

  let resolveBestMove: ((eval_: EngineEvaluation) => void) | null = null
  let resolveAnalysis: ((lines: EngineLine[]) => void) | null = null
  let onProgressCallback: ((lines: EngineLine[]) => void) | null = null
  // When true, we sent `stop` to abort a search and are waiting for its bestmove
  // before we can safely send the next position+go.
  let awaitingStopAck = false
  let pendingSearch: PendingSearch | null = null
  let pendingBestMove: PendingBestMove | null = null
  let analysisLines: Map<number, EngineLine> = new Map()
  let lastScoreCP: number | null = null
  let lastScoreMate: number | null = null

  // Assigned once startEngine() runs; every usage below happens only after `isReady`
  // becomes true, which can't happen before that.
  let worker!: Worker

  function positionCommand(fen: string, moves: string[]): string {
    return moves.length > 0 ? `position fen ${fen} moves ${moves.join(' ')}` : `position fen ${fen}`
  }

  // Best-move searches must always run single-line: an aborted analysis search never
  // reaches the MultiPV reset in the bestmove handler, so without setting it here a
  // leftover MultiPV=3 would leak into play and skew the position evaluation.
  function launchBestMoveSearch(pb: PendingBestMove): void {
    isThinking.value = true
    resolveBestMove = pb.resolve
    worker.postMessage('setoption name MultiPV value 1')
    worker.postMessage(positionCommand(pb.fen, pb.moves))
    worker.postMessage(`go movetime ${pb.thinkingTimeMs}`)
  }

  function launchSearch(ps: PendingSearch): void {
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
    worker = new Worker('/engines/stockfish-18-lite-single.js')

    worker.onmessage = (event: MessageEvent<string>) => {
      const line = event.data
      if (line === 'uciok') {
        worker.postMessage('isready')
      } else if (line === 'readyok') {
        isReady.value = true
        downloadProgress.value = null
      } else if (line.startsWith('info')) {
        // Ignore info lines while waiting for the stop acknowledgement —
        // they belong to the search we just aborted.
        if ((!resolveBestMove && !resolveAnalysis) || awaitingStopAck) return

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
        if (resolveBestMove) {
          const move = line.split(' ')[1]
          resolveBestMove({
            bestMove: move && move !== '(none)' ? move : null,
            scoreCP: lastScoreCP,
            scoreMate: lastScoreMate,
          })
          resolveBestMove = null
          lastScoreCP = null
          lastScoreMate = null
          isThinking.value = false
        } else if (awaitingStopAck) {
          // Engine has fully stopped — now safe to send new commands.
          awaitingStopAck = false
          if (pendingSearch) {
            const ps = pendingSearch
            pendingSearch = null
            launchSearch(ps)
          } else if (pendingBestMove) {
            const pb = pendingBestMove
            pendingBestMove = null
            launchBestMoveSearch(pb)
          } else {
            isThinking.value = false
          }
        } else if (resolveAnalysis) {
          const result = [...analysisLines.values()].sort((a, b) => a.multipvIndex - b.multipvIndex)
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
      resolveBestMove?.({ bestMove: null, scoreCP: null, scoreMate: null })
      resolveBestMove = null
      resolveAnalysis?.([])
      resolveAnalysis = null
      pendingSearch?.resolve([])
      pendingSearch = null
      pendingBestMove?.resolve({ bestMove: null, scoreCP: null, scoreMate: null })
      pendingBestMove = null
      onProgressCallback = null
      awaitingStopAck = false
      isThinking.value = false
    }

    const progressChannel = new MessageChannel()
    progressChannel.port1.onmessage = (event: MessageEvent<EngineDownloadProgress>) => {
      if (!isReady.value) downloadProgress.value = event.data
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

  async function getBestMove(
    fen: string,
    moves: string[] = [],
    thinkingTimeMs: number = DEFAULT_BEST_MOVE_THINKING_TIME_MS,
  ): Promise<EngineEvaluation> {
    await waitForReady()

    if (resolveAnalysis || awaitingStopAck || resolveBestMove) {
      // A search is already running or stop is in-flight — stop it and queue ourselves.
      if (!awaitingStopAck) {
        awaitingStopAck = true
        onProgressCallback = null
        resolveAnalysis?.([])
        resolveAnalysis = null
        pendingSearch?.resolve([])
        pendingSearch = null
        resolveBestMove?.({ bestMove: null, scoreCP: null, scoreMate: null })
        resolveBestMove = null
        worker.postMessage('stop')
      }
      // Replace any already-queued best-move request.
      pendingBestMove?.resolve({ bestMove: null, scoreCP: null, scoreMate: null })
      return new Promise<EngineEvaluation>((resolve) => {
        pendingBestMove = { fen, moves, thinkingTimeMs, resolve }
      })
    }

    return new Promise<EngineEvaluation>((resolve) => {
      launchBestMoveSearch({ fen, moves, thinkingTimeMs, resolve })
    })
  }

  async function getAnalysis(
    fen: string,
    lines: number,
    thinkingTimeMs: number,
    moves: string[] = [],
    onProgress?: (lines: EngineLine[]) => void,
  ): Promise<EngineLine[]> {
    await waitForReady()

    if (resolveAnalysis || awaitingStopAck || resolveBestMove) {
      // A search is running (or we already sent stop and are waiting for its ack).
      // Send stop only once — if awaitingStopAck is already true we've already sent it.
      if (!awaitingStopAck) {
        awaitingStopAck = true
        onProgressCallback = null
        resolveAnalysis?.([])
        resolveAnalysis = null
        resolveBestMove?.({ bestMove: null, scoreCP: null, scoreMate: null })
        resolveBestMove = null
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
    pendingBestMove?.resolve({ bestMove: null, scoreCP: null, scoreMate: null })
    pendingBestMove = null
    if (resolveAnalysis && !awaitingStopAck) {
      awaitingStopAck = true
      onProgressCallback = null
      resolveAnalysis([])
      resolveAnalysis = null
      worker.postMessage('stop')
    }
  }

  return { isReady, isThinking, downloadProgress, getBestMove, getAnalysis, stopAnalysis }
}

export function useStockfishEngine(): StockfishEngine {
  instance ??= createEngine()
  return instance
}
