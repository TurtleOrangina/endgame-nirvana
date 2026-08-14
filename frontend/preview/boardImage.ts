// Draws a position as a PNG by compositing raw pixels: the board texture and the piece
// sprites are pre-rasterized into worker/og-sprites.bin (see scripts/build-og-sprites.mjs),
// because the Workers runtime has no image decoder and the app's board is a webp texture
// plus a set of SVGs.

import { encodeTruecolorPng } from './png'
import type { ParsedPosition } from './fen'

export interface BoardSprites {
  boardSize: number
  squareSize: number
  // RGB, boardSize x boardSize — the full 8x8 texture, pattern included
  board: Uint8Array
  // RGBA, squareSize x squareSize, keyed by piece code ('wK', …)
  pieces: Map<string, Uint8Array>
}

const BLOB_MAGIC = 'ENOG'
const BLOB_VERSION = 1

async function inflate(blob: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Response(blob).body!.pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

// The blob is self-describing (sizes and piece codes live in its header) so this and the
// generator script cannot drift apart on constants neither of them can see.
export async function decodeSprites(blob: ArrayBuffer): Promise<BoardSprites> {
  const bytes = await inflate(blob)
  const header = new DataView(bytes.buffer, bytes.byteOffset)
  const magic = String.fromCodePoint(...bytes.subarray(0, 4))
  if (magic !== BLOB_MAGIC || header.getUint8(4) !== BLOB_VERSION) {
    throw new Error(`Unrecognized sprite blob (magic ${magic}, version ${header.getUint8(4)})`)
  }

  const boardSize = header.getUint16(5, true)
  const squareSize = header.getUint8(7)
  const pieceCount = header.getUint8(8)
  const codes: string[] = []
  for (let index = 0; index < pieceCount; index += 1) {
    codes.push(String.fromCodePoint(...bytes.subarray(9 + index * 2, 11 + index * 2)))
  }

  let offset = 9 + pieceCount * 2
  const board = bytes.subarray(offset, offset + boardSize * boardSize * 3)
  offset += board.length

  const spriteLength = squareSize * squareSize * 4
  const pieces = new Map<string, Uint8Array>()
  for (const code of codes) {
    pieces.set(code, bytes.subarray(offset, offset + spriteLength))
    offset += spriteLength
  }

  return { boardSize, squareSize, board, pieces }
}

function drawPiece(
  target: Uint8Array,
  sprites: BoardSprites,
  sprite: Uint8Array,
  column: number,
  row: number,
): void {
  const { boardSize, squareSize } = sprites
  for (let y = 0; y < squareSize; y += 1) {
    let source = y * squareSize * 4
    let destination = ((row * squareSize + y) * boardSize + column * squareSize) * 3
    for (let x = 0; x < squareSize; x += 1) {
      const alpha = sprite[source + 3]!
      if (alpha === 255) {
        target[destination] = sprite[source]!
        target[destination + 1] = sprite[source + 1]!
        target[destination + 2] = sprite[source + 2]!
      } else if (alpha !== 0) {
        for (let channel = 0; channel < 3; channel += 1) {
          const blended =
            sprite[source + channel]! * alpha + target[destination + channel]! * (255 - alpha)
          target[destination + channel] = (blended / 255 + 0.5) | 0
        }
      }
      source += 4
      destination += 3
    }
  }
}

// The side to move is always at the bottom, so whoever opens the link sees the position
// from the perspective they are being asked to play it from.
export function renderPosition(sprites: BoardSprites, position: ParsedPosition): Uint8Array {
  const pixels = new Uint8Array(sprites.board)
  const whiteAtBottom = position.sideToMove === 'w'
  for (const piece of position.pieces) {
    const sprite = sprites.pieces.get(piece.code)
    if (!sprite) continue
    const column = whiteAtBottom ? piece.file : 7 - piece.file
    const row = whiteAtBottom ? 7 - piece.rank : piece.rank
    drawPiece(pixels, sprites, sprite, column, row)
  }
  return pixels
}

export function renderPositionPng(sprites: BoardSprites, position: ParsedPosition): Uint8Array {
  return encodeTruecolorPng(renderPosition(sprites, position), sprites.boardSize, sprites.boardSize)
}
