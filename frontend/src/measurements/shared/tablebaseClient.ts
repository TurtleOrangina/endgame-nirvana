import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const TABLEBASE_URL = 'https://tablebase.lichess.ovh/standard'

// Lichess asks API clients to stay well below one request per second and to back off for
// a full minute on a 429. Every lookup in the measurement goes through this one
// serialized, disk-cached client, so a whole run makes at most one network request per
// distinct position — and none at all on a re-run.
const DEFAULT_MIN_REQUEST_INTERVAL_MS = 1100
const RATE_LIMIT_BACKOFF_MS = 60_000
const MAX_ATTEMPTS = 5

export interface RawTablebaseMove {
  uci: string
  san: string
  zeroing?: boolean
  conversion?: boolean
  checkmate?: boolean
  stalemate?: boolean
  insufficient_material?: boolean
  dtz?: number | null
  precise_dtz?: number | null
  dtm?: number | null
  dtw?: number | null
  dtc?: number | null
  category?: string
}

export interface RawTablebasePosition {
  category?: string
  dtz?: number | null
  dtm?: number | null
  checkmate?: boolean
  stalemate?: boolean
  insufficient_material?: boolean
  moves?: RawTablebaseMove[]
}

export interface TablebaseClient {
  lookup(fen: string): Promise<RawTablebasePosition>
  // Redirects the tablebase requests the app's `useLichessTablebase` composable makes
  // through this client, so move selection and the measurement share one cache and one
  // rate limiter instead of querying Lichess twice for the same position.
  installFetchInterception(): void
  networkRequestCount(): number
  cacheHitCount(): number
  /**
   * Called on every lookup — cached ones included — with the position's cache key, and
   * returns a function that removes the listener again. This is how the playout counts the
   * tablebase work behind a defender move: what matters there is which positions the
   * defender consulted, not which of them happened to still need the network.
   */
  addLookupListener(listener: (positionKey: string) => void): () => void
}

// The halfmove clock stays in the key: it decides whether a win still fits within the
// 50-move rule (cursed wins). The fullmove number never affects the answer.
function cacheKey(fen: string): string {
  return fen.split(' ').slice(0, 5).join(' ')
}

/**
 * A client that has no tablebase at all: every lookup fails the way `fetch` fails with no
 * network, and nothing is ever cached or counted. It exists so a defender can be measured
 * under the conditions an offline user plays under — the app keeps working offline, and the
 * selector then has to defend on the engine search alone.
 *
 * The failure is a rejection rather than a hang because that is what a browser does offline;
 * either way `useMoveSelector` never awaits its own lookup, so a request that resolves too
 * late and one that never resolves are the same opponent.
 */
export function createOfflineTablebaseClient(): TablebaseClient {
  const networkFetch = globalThis.fetch.bind(globalThis)
  const offlineError = (): Error => new TypeError('fetch failed (offline tablebase)')

  return {
    lookup: () => Promise.reject(offlineError()),
    installFetchInterception: () => {
      globalThis.fetch = async (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!url.startsWith(TABLEBASE_URL)) return networkFetch(input, init)
        throw offlineError()
      }
    },
    networkRequestCount: () => 0,
    cacheHitCount: () => 0,
    // No lookup ever happens, so there is nothing to notify about: the playout's tablebase
    // coverage comes out at 0%, which is exactly what this defender is
    addLookupListener: () => () => {},
  }
}

export function createTablebaseClient(
  cacheDir: string,
  minRequestIntervalMs: number = DEFAULT_MIN_REQUEST_INTERVAL_MS,
): TablebaseClient {
  mkdirSync(cacheDir, { recursive: true })

  // Captured before `installFetchInterception` can replace the global, so this client's
  // own requests still reach the network instead of being routed back into itself
  const networkFetch = globalThis.fetch.bind(globalThis)
  const memoryCache = new Map<string, Promise<RawTablebasePosition>>()
  let networkRequests = 0
  let cacheHits = 0
  const lookupListeners = new Set<(positionKey: string) => void>()
  // Serializes every network request and spaces them out; each lookup chains onto the
  // previous one, so requests can never overlap however many callers are waiting.
  let requestChain: Promise<unknown> = Promise.resolve()
  let nextRequestAllowedAt = 0

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

  function cacheFilePath(key: string): string {
    return path.join(cacheDir, `${createHash('sha1').update(key).digest('hex')}.json`)
  }

  function readFromDisk(key: string): RawTablebasePosition | null {
    try {
      return JSON.parse(readFileSync(cacheFilePath(key), 'utf8')) as RawTablebasePosition
    } catch {
      return null
    }
  }

  async function fetchFromLichess(fen: string): Promise<RawTablebasePosition> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await sleep(nextRequestAllowedAt - Date.now())
      nextRequestAllowedAt = Date.now() + minRequestIntervalMs
      networkRequests++
      try {
        const response = await networkFetch(`${TABLEBASE_URL}?fen=${encodeURIComponent(fen)}`)
        if (response.status === 429) {
          console.warn(`Tablebase rate-limited, backing off for ${RATE_LIMIT_BACKOFF_MS / 1000}s`)
          nextRequestAllowedAt = Date.now() + RATE_LIMIT_BACKOFF_MS
          continue
        }
        if (!response.ok) throw new Error(`Tablebase responded ${response.status}`)
        return (await response.json()) as RawTablebasePosition
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) throw error
        // Exponential backoff on transport failures, on top of the normal spacing
        nextRequestAllowedAt = Date.now() + minRequestIntervalMs * 2 ** attempt
      }
    }
    throw new Error(`Tablebase lookup failed after ${MAX_ATTEMPTS} attempts: ${fen}`)
  }

  function lookup(fen: string): Promise<RawTablebasePosition> {
    const key = cacheKey(fen)
    for (const listener of lookupListeners) listener(key)
    const inFlight = memoryCache.get(key)
    if (inFlight) {
      cacheHits++
      return inFlight
    }

    const onDisk = readFromDisk(key)
    if (onDisk) {
      const resolved = Promise.resolve(onDisk)
      memoryCache.set(key, resolved)
      return resolved
    }

    const pending = requestChain
      .then(() => fetchFromLichess(fen))
      .then((result) => {
        writeFileSync(cacheFilePath(key), JSON.stringify(result))
        return result
      })
    // Chained on regardless of outcome so one failure doesn't stall every later lookup
    requestChain = pending.catch(() => undefined)
    memoryCache.set(key, pending)
    pending.catch(() => memoryCache.delete(key))
    return pending
  }

  function installFetchInterception(): void {
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith(TABLEBASE_URL)) return networkFetch(input, init)
      const fen = new URL(url).searchParams.get('fen')
      if (fen === null) return new Response('missing fen', { status: 400 })
      try {
        return Response.json(await lookup(fen))
      } catch {
        return new Response('tablebase lookup failed', { status: 503 })
      }
    }
  }

  return {
    lookup,
    installFetchInterception,
    networkRequestCount: () => networkRequests,
    cacheHitCount: () => cacheHits,
    addLookupListener: (listener) => {
      lookupListeners.add(listener)
      return () => lookupListeners.delete(listener)
    },
  }
}
