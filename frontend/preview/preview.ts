// Builds the Open Graph / Twitter Card markup for a shared puzzle link and splices it
// into the SPA's index.html. Crawlers (Discord, Slack, WhatsApp, Telegram, Twitter…) do
// not run JavaScript, so anything the app sets at runtime is invisible to them — the
// tags have to be in the document the edge serves.

import { describeSideToMove, type ParsedPosition } from './fen'

export const BOARD_IMAGE_PATH = '/og/board.png'
export const PUZZLE_QUERY_PARAM = 'puzzle'

const SITE_NAME = 'Endgame Nirvana'

// Crawler previews carry no locale hint, so this copy stays English regardless of the
// reader's app language.
const DESCRIPTION = `Practice your endgame technique with ${SITE_NAME}.`

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

interface PreviewTagsOptions {
  position: ParsedPosition
  // The shared link itself, used verbatim as og:url
  pageUrl: URL
  // Raw fen exactly as it appeared in the URL
  rawFen: string
  boardSize: number
}

export function buildPreviewTags({
  position,
  pageUrl,
  rawFen,
  boardSize,
}: PreviewTagsOptions): string {
  const title = describeSideToMove(position)
  const imageUrl = new URL(BOARD_IMAGE_PATH, pageUrl)
  imageUrl.searchParams.set(PUZZLE_QUERY_PARAM, rawFen)

  const tags: [string, string][] = [
    ['og:type', 'website'],
    ['og:site_name', SITE_NAME],
    ['og:title', title],
    ['og:description', DESCRIPTION],
    ['og:url', pageUrl.toString()],
    ['og:image', imageUrl.toString()],
    ['og:image:type', 'image/png'],
    ['og:image:width', String(boardSize)],
    ['og:image:height', String(boardSize)],
    ['og:image:alt', `Chess board: ${title}`],
  ]
  // Twitter reads og:* for everything but the card type. 'summary' keeps the square
  // board intact — 'summary_large_image' would crop it to 1.91:1.
  // Twitter reads og:* for everything but the card type; `description` is for the
  // crawlers that never learned Open Graph at all.
  const namedTags: [string, string][] = [
    ['description', DESCRIPTION],
    ['twitter:card', 'summary'],
  ]

  return [
    `<title>${escapeHtmlAttribute(title)}</title>`,
    ...tags.map(
      ([property, content]) =>
        `<meta property="${property}" content="${escapeHtmlAttribute(content)}" />`,
    ),
    ...namedTags.map(
      ([name, content]) => `<meta name="${name}" content="${escapeHtmlAttribute(content)}" />`,
    ),
  ].join('\n    ')
}

// index.html carries a default preview of its own (see the marked block there), which
// this replaces wholesale — two og:titles in one document and it is the platform's guess
// which one a shared puzzle previews as.
const DEFAULT_PREVIEW_COMMENT = /<!--\s*link-preview:default[\S\s]*?-->\s*/
const EXISTING_TITLE = /<title>.*?<\/title>\s*/s
const EXISTING_PREVIEW_TAGS =
  /<meta\s+(?:property="og:[^"]*"|name="(?:twitter:[^"]*|description)")[^>]*>\s*/g

export function injectPreviewTags(html: string, tags: string): string {
  const stripped = html
    .replace(DEFAULT_PREVIEW_COMMENT, '')
    .replace(EXISTING_TITLE, '')
    .replaceAll(EXISTING_PREVIEW_TAGS, '')
  const headEnd = stripped.indexOf('</head>')
  if (headEnd === -1) return stripped
  // Re-indented rather than dropped in where </head> happened to start, so view-source
  // on a shared link reads like the rest of the document.
  return `${stripped.slice(0, headEnd).trimEnd()}\n    ${tags}\n  ${stripped.slice(headEnd)}`
}
