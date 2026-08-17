import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { PIECE_CODES } from '@/utils/boardAppearance'
import { preloadActiveAppearanceAssets } from '@/utils/preloadAssets'

// jsdom implements neither fetch nor object URLs; both are stubbed so the preloader's
// download/display path can be driven directly.
let objectUrlCounter = 0
const revokedObjectUrls: string[] = []

// The counter deliberately keeps running across tests: the preloader remembers which
// object URL each CSS variable is showing, so a reused name would look like the URL a
// previous test left behind.
function stubObjectUrls(): void {
  revokedObjectUrls.length = 0
  URL.createObjectURL = vi.fn(() => `blob:stub/${++objectUrlCounter}`)
  URL.revokeObjectURL = vi.fn((url: string) => void revokedObjectUrls.push(url))
}

// The preloader only ever passes a plain URL string, so the stub takes one directly
// instead of narrowing fetch's full input type.
function respondWith(handle: (url: string) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn((url: string) => Promise.resolve(handle(url))) as unknown as typeof fetch
}

function cssImageUrl(variable: string): string {
  return document.documentElement.style.getPropertyValue(variable)
}

function displayedImageVariables(): string[] {
  return ['--board-image', ...PIECE_CODES.map((code) => `--piece-${code}`)]
}

beforeEach(() => {
  stubObjectUrls()
  document.documentElement.removeAttribute('style')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('preloadActiveAppearanceAssets', () => {
  test('shows every active piece and the board from the downloaded bytes', async () => {
    respondWith(() => new Response('<svg/>'))

    preloadActiveAppearanceAssets('cburnett', 'green')
    await vi.waitFor(() => expect(cssImageUrl('--piece-bK')).toMatch(/^url\('blob:/))

    for (const variable of displayedImageVariables()) {
      expect(cssImageUrl(variable)).toMatch(/^url\('blob:/)
    }
  })

  test('keeps retrying an asset whose download failed, then shows it', async () => {
    vi.useFakeTimers()
    let whiteQueenAttempts = 0
    respondWith((url) => {
      if (!url.endsWith('/wQ.svg')) return new Response('<svg/>')
      whiteQueenAttempts += 1
      return whiteQueenAttempts === 1 ? Response.error() : new Response('<svg/>')
    })

    preloadActiveAppearanceAssets('maestro', 'wood4')
    // Long enough to cover the first retry delay; advancing also flushes the downloads.
    await vi.advanceTimersByTimeAsync(6_000)

    expect(whiteQueenAttempts).toBe(2)
    expect(cssImageUrl('--piece-wQ')).toMatch(/^url\('blob:/)
  })

  test('gives up on a download that stalls, then shows it on the retry', async () => {
    vi.useFakeTimers()
    let whiteQueenAttempts = 0
    // A request that hangs until aborted — what a first visit produces when the piece
    // SVGs queue behind the engine download.
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (!url.endsWith('/wQ.svg')) return Promise.resolve(new Response('<svg/>'))
      whiteQueenAttempts += 1
      if (whiteQueenAttempts > 1) return Promise.resolve(new Response('<svg/>'))
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }) as unknown as typeof fetch

    preloadActiveAppearanceAssets('kosal', 'olive')
    // Past the download timeout and the first retry delay behind it.
    await vi.advanceTimersByTimeAsync(30_000)

    expect(whiteQueenAttempts).toBe(2)
    expect(cssImageUrl('--piece-wQ')).toMatch(/^url\('blob:/)
  })

  test('retries an asset that arrives with an empty body rather than showing nothing', async () => {
    vi.useFakeTimers()
    let blackKingAttempts = 0
    respondWith((url) => {
      if (!url.endsWith('/bK.svg')) return new Response('<svg/>')
      blackKingAttempts += 1
      return new Response(blackKingAttempts === 1 ? '' : '<svg/>')
    })

    preloadActiveAppearanceAssets('merida', 'brown')
    await vi.advanceTimersByTimeAsync(6_000)

    expect(blackKingAttempts).toBe(2)
    expect(cssImageUrl('--piece-bK')).toMatch(/^url\('blob:/)
  })

  test('discards a download that lands after the user picked another piece set', async () => {
    const pendingResponses: Array<(response: Response) => void> = []
    respondWith(
      (url) =>
        new Promise<Response>((resolve) => {
          if (url.endsWith('/staunty/wK.svg')) pendingResponses.push(resolve)
          else resolve(new Response('<svg/>'))
        }),
    )

    preloadActiveAppearanceAssets('staunty', 'wood4')
    await vi.waitFor(() => expect(pendingResponses.length).toBe(1))

    preloadActiveAppearanceAssets('merida', 'wood4')
    await vi.waitFor(() => expect(cssImageUrl('--piece-wK')).toMatch(/^url\('blob:/))
    const shownWhiteKing = cssImageUrl('--piece-wK')

    const objectUrlsBeforeStaleArrival = objectUrlCounter
    pendingResponses[0]?.(new Response('<svg/>'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(objectUrlCounter).toBe(objectUrlsBeforeStaleArrival)
    expect(cssImageUrl('--piece-wK')).toBe(shownWhiteKing)
    expect(revokedObjectUrls).not.toContain(shownWhiteKing.replace(/^url\('|'\)$/g, ''))
  })
})
