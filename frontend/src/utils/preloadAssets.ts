import {
  BOARD_THEME_IDS,
  boardImageUrl,
  boardThemeOrDefault,
  PIECE_SET_IDS,
  pieceImageUrls,
  pieceSetOrDefault,
  type BoardThemeId,
  type PieceSetId,
} from '@/utils/boardAppearance'

const INITIAL_RETRY_DELAY_MS = 5_000
const MAX_RETRY_DELAY_MS = 5 * 60_000
// The background prefetch alone is ~180 files. Firing them all at once would saturate
// the connection the app itself needs (catalog, engine, tablebase), so downloads run a
// few at a time; the active set is small enough to stay under this anyway.
const MAX_PARALLEL_DOWNLOADS = 6
const IDLE_PREFETCH_DELAY_MS = 10_000

// fetch() rather than new Image(): an Image gave no completion signal, so on a bad
// connection a piece whose download failed was silently never retried — leaving e.g. a
// promoted queen invisible for the rest of an offline stretch. fetch() exposes the
// outcome per asset, letting the failed ones be retried until the whole set is
// confirmed downloaded; in production the requests also pass through the service
// worker (public/sw.js), landing each response in its cache rather than relying on
// the HTTP cache alone.
//
// Piece images are only fetched by the browser once a piece actually appears on the
// board via its CSS class (see assets/board-appearance.css), so a puzzle whose starting
// position happens to lack e.g. a black queen would leave bQ.svg undownloaded — invisible
// if the user goes offline before ever encountering one (say, via a promotion). Preloading
// the whole active set up front (it's tiny) means it is always cached before it's needed.
export function preloadActiveAppearanceAssets(
  pieceSet: string | undefined,
  boardTheme: string | undefined,
): void {
  void retryUntilAllDownloaded([
    ...pieceImageUrls(pieceSetOrDefault(pieceSet)),
    boardImageUrl(boardThemeOrDefault(boardTheme)),
  ])
}

// The board themes and piece sets the user isn't currently using — ~500 KB over the
// wire, against the ~14 MB the engine already pulls — are fetched once the app is idle, so
// every option in the appearance settings can still be previewed and picked after the
// user goes offline. Deliberately not part of the startup path: what the user is
// actually looking at is preloaded first (preloadActiveAppearanceAssets above), and
// this only fills the cache behind it.
export function prefetchAllAppearanceAssets(
  activePieceSet: string | undefined,
  activeBoardTheme: string | undefined,
): void {
  const activeSet = pieceSetOrDefault(activePieceSet)
  const activeTheme = boardThemeOrDefault(activeBoardTheme)
  const urls = [
    ...PIECE_SET_IDS.filter((id: PieceSetId) => id !== activeSet).flatMap(pieceImageUrls),
    ...BOARD_THEME_IDS.filter((id: BoardThemeId) => id !== activeTheme).map(boardImageUrl),
  ]
  whenIdle(() => void retryUntilAllDownloaded(urls))
}

function whenIdle(run: () => void): void {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: IDLE_PREFETCH_DELAY_MS })
  } else {
    setTimeout(run, IDLE_PREFETCH_DELAY_MS)
  }
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
  const pending = [...urls]
  const failed: string[] = []
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_DOWNLOADS, pending.length) }, () =>
    (async () => {
      for (let url = pending.shift(); url !== undefined; url = pending.shift()) {
        if (!(await downloadedSuccessfully(url))) failed.push(url)
      }
    })(),
  )
  await Promise.all(workers)
  return failed
}

async function downloadedSuccessfully(url: string): Promise<boolean> {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
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
