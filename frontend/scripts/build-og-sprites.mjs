// Rasterizes the board texture and piece set used by the link-preview images
// (preview/boardImage.ts) into a single deflated blob, committed as
// public/og-sprites.bin. The Pages Function has no image decoder — it composites raw
// pixels — so every asset it draws has to be turned into raw RGB(A) ahead of time.
//
// Run after changing PREVIEW_BOARD_THEME / PREVIEW_PIECE_SET or the size constants:
//   node scripts/build-og-sprites.mjs
//
// sharp is a devDependency used only here; the generated blob is committed, so neither
// it nor this script is needed for a normal build or deploy.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

// Must match the app's DEFAULT_BOARD_THEME / DEFAULT_PIECE_SET (src/utils/boardAppearance.ts)
// so a shared link previews in the same colours the app opens it in.
const PREVIEW_BOARD_THEME = 'wood4'
const PREVIEW_PIECE_SET = 'maestro'

// 512px board = 64px squares. Kept deliberately modest: the Worker encodes the PNG
// without compression (see worker/png.ts) to stay inside the free plan's 10ms CPU
// budget per request, so every extra pixel is bytes on the wire and CPU in the
// checksum passes. 512px still renders crisply at the ~400px preview cards get.
const BOARD_SIZE = 512
const SQUARE_SIZE = BOARD_SIZE / 8

// Draw order is irrelevant, but the blob's index is: the Worker looks pieces up by the
// codes recorded in the header, so this array defines the on-disk layout.
const PIECE_CODES = ['wK', 'wQ', 'wR', 'wB', 'wN', 'wP', 'bK', 'bQ', 'bR', 'bB', 'bN', 'bP']

const BLOB_VERSION = 1

// The piece SVGs use a 50-unit viewBox. Rasterizing at 4x the target and resizing down
// gives clean antialiasing — sharp otherwise renders SVGs at 72dpi (50px) and upscales.
const SVG_UNITS = 50
const SUPERSAMPLE = 4

async function rasterizePiece(code) {
  const source = path.join(projectRoot, 'public', 'piece', PREVIEW_PIECE_SET, `${code}.svg`)
  const density = (72 / SVG_UNITS) * SQUARE_SIZE * SUPERSAMPLE
  return await sharp(source, { density })
    .resize(SQUARE_SIZE, SQUARE_SIZE, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .ensureAlpha()
    .raw()
    .toBuffer()
}

async function rasterizeBoard() {
  const source = path.join(projectRoot, 'public', 'board', `${PREVIEW_BOARD_THEME}.webp`)
  return await sharp(source).resize(BOARD_SIZE, BOARD_SIZE).removeAlpha().raw().toBuffer()
}

function buildHeader() {
  const header = Buffer.alloc(9 + PIECE_CODES.length * 2)
  header.write('ENOG', 0, 'ascii')
  header.writeUInt8(BLOB_VERSION, 4)
  header.writeUInt16LE(BOARD_SIZE, 5)
  header.writeUInt8(SQUARE_SIZE, 7)
  header.writeUInt8(PIECE_CODES.length, 8)
  for (const [index, code] of PIECE_CODES.entries()) header.write(code, 9 + index * 2, 'ascii')
  return header
}

const board = await rasterizeBoard()
const pieces = await Promise.all(PIECE_CODES.map(rasterizePiece))
const blob = deflateSync(Buffer.concat([buildHeader(), board, ...pieces]), { level: 9 })

// Shipped as a static asset rather than bundled into the Function: Pages Functions are
// JavaScript modules, and the ASSETS binding hands the blob over just as well.
const target = path.join(projectRoot, 'public', 'og-sprites.bin')
writeFileSync(target, blob)

const kilobytes = (bytes) => `${(bytes / 1024).toFixed(0)} KB`
console.log(
  `Wrote ${path.relative(projectRoot, target)}: ${PREVIEW_BOARD_THEME} board at ${BOARD_SIZE}px + ` +
    `${PIECE_CODES.length} ${PREVIEW_PIECE_SET} pieces at ${SQUARE_SIZE}px, ` +
    `${kilobytes(blob.length)} deflated (${kilobytes(board.length + pieces[0].length * 12)} raw)`,
)
