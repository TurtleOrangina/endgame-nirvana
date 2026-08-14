// @vitest-environment node
// Rendering leans on DecompressionStream and reads the sprite blob off disk — neither
// belongs in the jsdom environment the app's own tests use.
import { readFileSync } from 'node:fs'

import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vite-plus/test'

import { decodeSprites, renderPosition, renderPositionPng, type BoardSprites } from '../boardImage'
import { parseFen } from '../fen'

// The blob ships as a static asset; the Function fetches it through the ASSETS binding.
const blobPath = new URL('../../public/og-sprites.bin', import.meta.url).pathname

let sprites: BoardSprites

beforeAll(async () => {
  const file = readFileSync(blobPath)
  sprites = await decodeSprites(
    file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer,
  )
})

// True where the rendered board differs from the bare texture — i.e. where a piece landed.
function squareHasPiece(pixels: Uint8Array, column: number, row: number): boolean {
  const { boardSize, squareSize, board } = sprites
  for (let y = row * squareSize; y < (row + 1) * squareSize; y += 1) {
    const start = (y * boardSize + column * squareSize) * 3
    const end = start + squareSize * 3
    for (let index = start; index < end; index += 1) {
      if (pixels[index] !== board[index]) return true
    }
  }
  return false
}

describe('decodeSprites', () => {
  it('reads the sizes and piece codes out of the committed blob', () => {
    expect(sprites.boardSize).toBe(512)
    expect(sprites.squareSize).toBe(64)
    expect(sprites.pieces.size).toBe(12)
    expect(sprites.board).toHaveLength(512 * 512 * 3)
    expect(sprites.pieces.get('wK')).toHaveLength(64 * 64 * 4)
  })
})

describe('renderPosition', () => {
  it('puts white at the bottom when white is to play', () => {
    const pixels = renderPosition(sprites, parseFen('8/8/8/8/8/8/8/K6k w - - 0 1')!)
    // a1 is the bottom-left square, h1 the bottom-right
    expect(squareHasPiece(pixels, 0, 7)).toBe(true)
    expect(squareHasPiece(pixels, 7, 7)).toBe(true)
    expect(squareHasPiece(pixels, 0, 0)).toBe(false)
  })

  it('flips the board when black is to play, so the reader plays up the screen', () => {
    const pixels = renderPosition(sprites, parseFen('8/8/8/8/8/8/8/K6k b - - 0 1')!)
    // Flipped, a1 sits top-right
    expect(squareHasPiece(pixels, 7, 0)).toBe(true)
    expect(squareHasPiece(pixels, 0, 0)).toBe(true)
    expect(squareHasPiece(pixels, 0, 7)).toBe(false)
  })

  it('leaves an empty board untouched', () => {
    const pixels = renderPosition(sprites, parseFen('8/8/8/8/8/8/8/8 w - - 0 1')!)
    expect(Buffer.from(pixels).equals(Buffer.from(sprites.board))).toBe(true)
  })
})

describe('renderPositionPng', () => {
  it('encodes a png a real decoder can read back', async () => {
    const png = renderPositionPng(sprites, parseFen('7R/1r6/8/8/8/8/3p1K2/3k4 b - - 0 1')!)
    const decoded = sharp(Buffer.from(png))
    const metadata = await decoded.metadata()
    expect(metadata.format).toBe('png')
    expect(metadata.width).toBe(512)
    expect(metadata.height).toBe(512)

    // Decoding to pixels proves the deflate framing and both checksums are sound, not
    // merely that the header parses.
    const rendered = renderPosition(sprites, parseFen('7R/1r6/8/8/8/8/3p1K2/3k4 b - - 0 1')!)
    const roundTripped = await decoded.raw().toBuffer()
    expect(Buffer.from(roundTripped).equals(Buffer.from(rendered))).toBe(true)
  })
})
