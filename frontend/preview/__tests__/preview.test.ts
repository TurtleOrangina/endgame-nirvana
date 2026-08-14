// @vitest-environment node
// The injection is checked against the real index.html, which means reading it off disk.
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vite-plus/test'
import { parseFen } from '../fen'
import {
  BOARD_IMAGE_PATH,
  buildPreviewTags,
  injectPreviewTags,
  PUZZLE_QUERY_PARAM,
} from '../preview'

const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url).pathname, 'utf8')

const RAW_FEN = '7R/1r6/8/8/8/8/3p1K2/3k4_b_-_-_0_1'
const PAGE_URL = new URL(`https://endgame-nirvana.space/train?puzzle=${RAW_FEN}`)

function tagsForSharedLink(): string {
  return buildPreviewTags({
    position: parseFen(RAW_FEN)!,
    pageUrl: PAGE_URL,
    rawFen: RAW_FEN,
    boardSize: 512,
  })
}

describe('buildPreviewTags', () => {
  it('titles the preview with nothing but the side to play', () => {
    expect(tagsForSharedLink()).toContain('<title>Black to play</title>')
    expect(tagsForSharedLink()).toContain('<meta property="og:title" content="Black to play" />')
  })

  it('points og:image at the board renderer for this very fen', () => {
    const imageUrl = /<meta property="og:image" content="([^"]+)"/.exec(tagsForSharedLink())?.[1]
    expect(imageUrl).toBeDefined()
    const parsed = new URL(imageUrl!)
    expect(parsed.origin).toBe('https://endgame-nirvana.space')
    expect(parsed.pathname).toBe('/og/board.png')
    expect(parsed.searchParams.get('puzzle')).toBe(RAW_FEN)
  })

  it('declares the image dimensions, so the board is laid out as a square', () => {
    expect(tagsForSharedLink()).toContain('<meta property="og:image:width" content="512" />')
    expect(tagsForSharedLink()).toContain('<meta property="og:image:height" content="512" />')
  })

  it('keeps the square board uncropped by asking for the small twitter card', () => {
    expect(tagsForSharedLink()).toContain('<meta name="twitter:card" content="summary" />')
  })

  it('escapes the url it echoes back, since it comes from whoever shared the link', () => {
    const tags = buildPreviewTags({
      position: parseFen(RAW_FEN)!,
      pageUrl: new URL(
        'https://endgame-nirvana.space/train?puzzle=8/8/8/8/8/8/8/Kk6_w&x="><script>',
      ),
      rawFen: RAW_FEN,
      boardSize: 512,
    })
    // The URL parser percent-encodes the angle brackets; the ampersand is ours to escape
    expect(tags).not.toContain('<script>')
    expect(tags).toContain('%3Cscript%3E')
    expect(tags).toContain('&amp;x=')
  })
})

// index.html carries a default preview for every page without a puzzle of its own.
describe('the default preview in index.html', () => {
  function defaultTagContent(property: string): string | undefined {
    return new RegExp(`<meta\\s+property="${property}"\\s+content="([^"]+)"`).exec(INDEX_HTML)?.[1]
  }

  it('is drawn by the board renderer, from a fen it can actually render', () => {
    const imageUrl = new URL(defaultTagContent('og:image')!)
    expect(imageUrl.pathname).toBe(BOARD_IMAGE_PATH)
    // A typo here would leave the front page previewing a 404 rather than a board
    expect(parseFen(imageUrl.searchParams.get(PUZZLE_QUERY_PARAM)!)).not.toBeNull()
  })

  it('greets rather than describing a position', () => {
    expect(defaultTagContent('og:title')).toBe('Welcome to Endgame Nirvana')
    expect(defaultTagContent('og:description')).toBe(
      'The place to practice your endgames — where endgames become second nature.',
    )
  })
})

describe('injectPreviewTags', () => {
  it('puts the tags inside the head', () => {
    const injected = injectPreviewTags(INDEX_HTML, tagsForSharedLink())
    expect(injected.indexOf('og:title')).toBeLessThan(injected.indexOf('</head>'))
    expect(injected).toContain('<meta charset="UTF-8" />')
  })

  it('drops the static title, so only the puzzle-specific one is left', () => {
    const injected = injectPreviewTags(INDEX_HTML, tagsForSharedLink())
    expect(injected).not.toContain('<title>Endgame Nirvana</title>')
    expect(injected.match(/<title>/g)).toHaveLength(1)
  })

  it('replaces the default preview instead of leaving two of everything', () => {
    const injected = injectPreviewTags(INDEX_HTML, tagsForSharedLink())
    for (const attribute of [
      'property="og:title"',
      'property="og:image"',
      'property="og:description"',
      'property="og:url"',
      'name="description"',
      'name="twitter:card"',
    ]) {
      expect(injected.match(new RegExp(attribute, 'g'))).toHaveLength(1)
    }
    expect(injected).not.toContain('Welcome to Endgame Nirvana')
    expect(injected).not.toContain('link-preview:default')
  })

  it('leaves the rest of the head alone', () => {
    const injected = injectPreviewTags(INDEX_HTML, tagsForSharedLink())
    expect(injected).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
    expect(injected).toContain(
      '<meta name="apple-mobile-web-app-title" content="Endgame Nirvana" />',
    )
    expect(injected).toContain('<meta name="theme-color" content="#1a1a2e" />')
  })
})
