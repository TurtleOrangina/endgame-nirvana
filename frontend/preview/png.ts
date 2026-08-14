// Minimal truecolour PNG encoder.
//
// The pixels are wrapped in *uncompressed* deflate blocks rather than being compressed.
// The Workers free plan allows 10ms of CPU per request, and deflating a megabyte of
// board texture does not fit in it; framing plus the two mandatory checksum passes does,
// comfortably. The cost is a fat image (~790 KB for a 512px board), which only matters
// once per position: the response is stored in the edge cache, and the crawlers that
// fetch it cache the result on their side too.

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// Deflate stores a block's length as a uint16, so blocks cap out at 65535 bytes.
const MAX_STORED_BLOCK = 0xff_ff

const CRC_TABLE = buildCrcTable()

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xed_b8_83_20 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value
  }
  return table
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xff_ff_ff_ff) >>> 0
}

function adler32(bytes: Uint8Array): number {
  let low = 1
  let high = 0
  // 5552 is the largest run that cannot overflow the 32-bit accumulators
  for (let start = 0; start < bytes.length; start += 5552) {
    const end = Math.min(start + 5552, bytes.length)
    for (let index = start; index < end; index += 1) {
      low += bytes[index]!
      high += low
    }
    low %= 65_521
    high %= 65_521
  }
  return ((high << 16) | low) >>> 0
}

class ByteWriter {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private offset = 0

  constructor(size: number) {
    this.bytes = new Uint8Array(size)
    this.view = new DataView(this.bytes.buffer)
  }

  writeBytes(source: Uint8Array): void {
    this.bytes.set(source, this.offset)
    this.offset += source.length
  }

  writeUint8(value: number): void {
    this.view.setUint8(this.offset, value)
    this.offset += 1
  }

  writeUint16LittleEndian(value: number): void {
    this.view.setUint16(this.offset, value, true)
    this.offset += 2
  }

  writeUint32(value: number): void {
    this.view.setUint32(this.offset, value)
    this.offset += 4
  }

  // A chunk is length + type + data + a CRC over type and data.
  writeChunk(type: string, data: Uint8Array): void {
    this.writeUint32(data.length)
    const typeStart = this.offset
    for (const character of type) this.writeUint8(character.codePointAt(0)!)
    this.writeBytes(data)
    this.writeUint32(crc32(this.bytes.subarray(typeStart, this.offset)))
  }

  get result(): Uint8Array {
    return this.bytes.subarray(0, this.offset)
  }
}

// PNG scanlines are each prefixed with a filter type; 0 means "stored as-is", which is
// what an uncompressed stream wants anyway.
function buildScanlines(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 3
  const scanlines = new Uint8Array(height * (rowBytes + 1))
  for (let row = 0; row < height; row += 1) {
    scanlines.set(pixels.subarray(row * rowBytes, (row + 1) * rowBytes), row * (rowBytes + 1) + 1)
  }
  return scanlines
}

function buildStoredZlibStream(scanlines: Uint8Array): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(scanlines.length / MAX_STORED_BLOCK))
  // 2-byte zlib header, 5 bytes of framing per block, 4-byte adler32 trailer
  const writer = new ByteWriter(2 + blockCount * 5 + scanlines.length + 4)

  // Compression method 8 (deflate), 32K window, no preset dictionary, fastest level
  writer.writeUint8(0x78)
  writer.writeUint8(0x01)

  for (let start = 0; start < scanlines.length || start === 0; start += MAX_STORED_BLOCK) {
    const end = Math.min(start + MAX_STORED_BLOCK, scanlines.length)
    const length = end - start
    writer.writeUint8(end >= scanlines.length ? 1 : 0)
    writer.writeUint16LittleEndian(length)
    writer.writeUint16LittleEndian(~length & 0xff_ff)
    writer.writeBytes(scanlines.subarray(start, end))
  }

  writer.writeUint32(adler32(scanlines))
  return writer.result
}

export function encodeTruecolorPng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const header = new ByteWriter(13)
  header.writeUint32(width)
  header.writeUint32(height)
  header.writeUint8(8) // bit depth
  header.writeUint8(2) // colour type 2: truecolour RGB
  header.writeUint8(0) // compression method: deflate
  header.writeUint8(0) // filter method
  header.writeUint8(0) // interlace method: none

  const imageData = buildStoredZlibStream(buildScanlines(pixels, width, height))

  const png = new ByteWriter(PNG_SIGNATURE.length + 25 + (12 + imageData.length) + 12)
  png.writeBytes(PNG_SIGNATURE)
  png.writeChunk('IHDR', header.result)
  png.writeChunk('IDAT', imageData)
  png.writeChunk('IEND', new Uint8Array(0))
  return png.result
}
