import wP from '@/assets/pieces-maestro/wP.svg'
import wN from '@/assets/pieces-maestro/wN.svg'
import wB from '@/assets/pieces-maestro/wB.svg'
import wR from '@/assets/pieces-maestro/wR.svg'
import wQ from '@/assets/pieces-maestro/wQ.svg'
import wK from '@/assets/pieces-maestro/wK.svg'
import bP from '@/assets/pieces-maestro/bP.svg'
import bN from '@/assets/pieces-maestro/bN.svg'
import bB from '@/assets/pieces-maestro/bB.svg'
import bR from '@/assets/pieces-maestro/bR.svg'
import bQ from '@/assets/pieces-maestro/bQ.svg'
import bK from '@/assets/pieces-maestro/bK.svg'
import chessBoard from '@/assets/chess-board.svg'

// Piece images are only fetched by the browser once a piece actually appears on the
// board via its CSS class (see pieces-maestro.css), so a puzzle whose starting position
// happens to lack e.g. a black queen would leave bQ.svg undownloaded — invisible if the
// user goes offline before ever encountering one (say, via a promotion). Preloading every
// piece up front (they're tiny) means the full set is always cached well before it's needed.
const ESSENTIAL_IMAGE_URLS = [wP, wN, wB, wR, wQ, wK, bP, bN, bB, bR, bQ, bK, chessBoard]

const INITIAL_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 5 * 60_000

// fetch() rather than new Image(): an Image gave no completion signal, so on a bad
// connection a piece whose download failed was silently never retried — leaving e.g. a
// promoted queen invisible for the rest of an offline stretch. fetch() exposes the
// outcome per asset, letting the failed ones be retried until the whole set is
// confirmed downloaded; in production the requests also pass through the service
// worker (public/sw.js), landing each response in its cache rather than relying on
// the HTTP cache alone.
export function preloadEssentialImages(): void {
  void retryUntilAllDownloaded(ESSENTIAL_IMAGE_URLS)
}

async function retryUntilAllDownloaded(urls: string[]): Promise<void> {
  let remaining = urls
  let retryDelayMs = INITIAL_RETRY_DELAY_MS
  while (remaining.length > 0) {
    remaining = await fetchAllReturningFailed(remaining)
    if (remaining.length === 0) return
    await connectivityRegainedOrTimeout(retryDelayMs)
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS)
  }
}

async function fetchAllReturningFailed(urls: string[]): Promise<string[]> {
  const outcomes = await Promise.all(
    urls.map(async (url) => {
      try {
        return { url, ok: (await fetch(url)).ok }
      } catch {
        return { url, ok: false }
      }
    }),
  )
  return outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome.url)
}

// Resolves when the browser reports connectivity came back, or after delayMs at the
// latest — the 'online' event is a hint, not a guarantee (and never fires when the
// connection was merely slow rather than down), so the timed retry stays as fallback.
function connectivityRegainedOrTimeout(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout)
      window.removeEventListener('online', finish)
      resolve()
    }
    const timeout = setTimeout(finish, delayMs)
    window.addEventListener('online', finish)
  })
}
