import {
  BOARD_THEME_IDS,
  boardImageUrl,
  boardThemeOrDefault,
  PIECE_CODES,
  PIECE_SET_IDS,
  pieceImageUrl,
  pieceImageUrls,
  pieceSetOrDefault,
  showBoardImage,
  showPieceImage,
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
// A request that never settles is not a failure the retry loop can see, so it would sit
// there forever holding its asset back — which is exactly what a first visit produces,
// where these requests queue behind the multi-megabyte engine download and can stall
// well past any useful wait. Aborting turns that stall into a plain failure, which the
// loop already knows how to retry (by then usually against a warm connection).
const DOWNLOAD_TIMEOUT_MS = 20_000

// An asset to download, plus — for the set that is actually on the board — where to
// show it once its bytes are in hand.
interface DownloadTarget {
  url: string
  display?: (blob: Blob) => void
}

// Keyed by the CSS variable the image is shown in, so the blob: URL that variable
// currently points at can be revoked once it has been replaced.
const shownObjectUrlsByVariable = new Map<string, string>()

// Bumped on every appearance change, so downloads still in flight for a set the user
// has since switched away from don't put that old set back on the board.
let activeAppearanceGeneration = 0

// The board theme and piece set currently being downloaded/displayed. App.vue watches
// the two profile fields separately, so both watchers fire on startup with the very
// same appearance; without this the whole active set would be downloaded twice, and the
// duplicate requests compete for the connection precisely on the first visit this is
// meant to rescue.
let appearanceBeingShown: string | undefined

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
//
// The active set is additionally *displayed* from the downloaded bytes (a blob: URL per
// image) rather than left to a second, independent browser image load: that load is the
// one that goes wrong on a first visit, where the piece SVGs compete with the engine and
// the catalog for the connection. A background-image whose request fails is never retried
// by the browser and no error surfaces anywhere, so the piece simply stayed invisible
// until the user reloaded the page. Retrying the fetch here fixed only the cache, not
// the board; pointing the CSS variable at the confirmed bytes fixes the board.
export function preloadActiveAppearanceAssets(
  pieceSet: string | undefined,
  boardTheme: string | undefined,
): void {
  const set = pieceSetOrDefault(pieceSet)
  const theme = boardThemeOrDefault(boardTheme)
  if (appearanceBeingShown === `${set}/${theme}`) return
  appearanceBeingShown = `${set}/${theme}`
  const generation = ++activeAppearanceGeneration

  // A download that lands after the user has switched appearance is discarded rather
  // than shown — including its object URL, which must not take over the variable the
  // now-current set is being displayed from.
  const displayInVariable =
    (variable: string, show: (objectUrl: string) => void) =>
    (blob: Blob): void => {
      if (generation !== activeAppearanceGeneration) return
      show(replaceObjectUrl(variable, blob))
    }

  void retryUntilAllDownloaded([
    ...PIECE_CODES.map((code) => ({
      url: pieceImageUrl(set, code),
      display: displayInVariable(`piece-${code}`, (objectUrl) => showPieceImage(code, objectUrl)),
    })),
    {
      url: boardImageUrl(theme),
      display: displayInVariable('board', showBoardImage),
    },
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
  whenIdle(() => void retryUntilAllDownloaded(urls.map((url) => ({ url }))))
}

function whenIdle(run: () => void): void {
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(run, { timeout: IDLE_PREFETCH_DELAY_MS })
  } else {
    setTimeout(run, IDLE_PREFETCH_DELAY_MS)
  }
}

async function retryUntilAllDownloaded(targets: DownloadTarget[]): Promise<void> {
  let remaining = targets
  let retryDelayMs = INITIAL_RETRY_DELAY_MS
  while (remaining.length > 0) {
    remaining = await downloadAllReturningFailed(remaining)
    if (remaining.length === 0) return
    await connectivityRegainedOrTimeout(retryDelayMs)
    retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS)
  }
}

async function downloadAllReturningFailed(targets: DownloadTarget[]): Promise<DownloadTarget[]> {
  const pending = [...targets]
  const failed: DownloadTarget[] = []
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_DOWNLOADS, pending.length) }, () =>
    (async () => {
      for (let target = pending.shift(); target !== undefined; target = pending.shift()) {
        if (await downloadedSuccessfully(target)) continue
        failed.push(target)
      }
    })(),
  )
  await Promise.all(workers)
  return failed
}

async function downloadedSuccessfully(target: DownloadTarget): Promise<boolean> {
  const blob = await downloadedBlob(target.url)
  if (!blob) return false
  target.display?.(blob)
  return true
}

async function downloadedBlob(url: string): Promise<Blob | null> {
  const abortStalled = new AbortController()
  const timeout = setTimeout(() => abortStalled.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: abortStalled.signal })
    if (!response.ok) return null
    const blob = await response.blob()
    // An empty body still arrives as a perfectly ok response, and showing the board a
    // blob: URL of nothing would leave the piece just as invisible — with the retry
    // loop believing it had succeeded. Treat it as a failure so it is fetched again.
    return blob.size > 0 ? blob : null
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

function replaceObjectUrl(variable: string, blob: Blob): string {
  const objectUrl = URL.createObjectURL(blob)
  const previous = shownObjectUrlsByVariable.get(variable)
  if (previous) URL.revokeObjectURL(previous)
  shownObjectUrlsByVariable.set(variable, objectUrl)
  return objectUrl
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
