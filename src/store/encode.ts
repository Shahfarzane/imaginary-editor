// 16-bit encoders for export: PNG (RGB, Paeth-filtered, zlib) and TIFF (RGB, Adobe Deflate with horizontal
// differencing), each with the ICC profile of its color space embedded. Browsers only encode 8 bits per channel.
import { Zlib, zlibSync } from 'fflate'

// Deflate level 1: on 16-bit photo pixels it is twice as fast as level 6 for a file 1% larger (the low bits are
// noise either way; a 12 MP export measured 1.5 s and 62.6 MB against 3.2 s and 62.0 MB).
const LEVEL = 1

/** RGB pixels, 16 bits per channel, top row first. */
export interface Pixels16 {
  width: number
  height: number
  data: Uint16Array
}

type Progress = (f: number) => void
const breathe = () => new Promise((r) => setTimeout(r, 0))

let crcTable: Uint32Array | null = null
export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8)
  return crc
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + data.length)
  const v = new DataView(out.buffer)
  v.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  v.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0)
  return out
}

/** A 16-bit RGB PNG with an iCCP chunk. */
export async function encodePng16(px: Pixels16, icc: Uint8Array, iccName: string, onProgress?: Progress): Promise<Blob> {
  const { width: W, height: H, data } = px
  const ihdr = new Uint8Array(13)
  const v = new DataView(ihdr.buffer)
  v.setUint32(0, W)
  v.setUint32(4, H)
  ihdr.set([16, 2, 0, 0, 0], 8)
  const name = new TextEncoder().encode(iccName.slice(0, 79))
  const iccp = new Uint8Array([...name, 0, 0, ...zlibSync(icc)])

  const parts: BlobPart[] = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', ihdr), pngChunk('iCCP', iccp)]
  const z = new Zlib({ level: LEVEL })
  z.ondata = (chunk) => parts.push(pngChunk('IDAT', chunk))
  // Each scanline: filter type 4 (Paeth) over big-endian samples, 6 bytes a pixel.
  const stride = W * 6
  let prev = new Uint8Array(stride)
  let raw = new Uint8Array(stride)
  const batch = 64
  for (let y0 = 0; y0 < H; y0 += batch) {
    const rows = Math.min(batch, H - y0)
    const out = new Uint8Array(rows * (stride + 1))
    for (let r = 0; r < rows; r++) {
      const src = (y0 + r) * W * 3
      for (let i = 0; i < W * 3; i++) {
        raw[i * 2] = data[src + i] >> 8
        raw[i * 2 + 1] = data[src + i] & 255
      }
      const o = r * (stride + 1)
      out[o] = 4
      for (let i = 0; i < stride; i++) {
        const a = i >= 6 ? raw[i - 6] : 0
        const b = prev[i]
        const c = i >= 6 ? prev[i - 6] : 0
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        out[o + 1 + i] = raw[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
      }
      ;[prev, raw] = [raw, prev]
    }
    z.push(out, y0 + rows >= H)
    onProgress?.((y0 + rows) / H)
    await breathe()
  }
  parts.push(pngChunk('IEND', new Uint8Array(0)))
  return new Blob(parts, { type: 'image/png' })
}

/** A 16-bit RGB TIFF (little-endian, Adobe Deflate, predictor 2) with the ICC profile in tag 34675. */
export async function encodeTiff16(px: Pixels16, icc: Uint8Array, onProgress?: Progress): Promise<Blob> {
  const { width: W, height: H, data } = px
  const rowBytes = W * 6
  const rowsPerStrip = Math.max(1, Math.floor((1 << 20) / rowBytes))
  const strips: Uint8Array[] = []
  for (let y0 = 0; y0 < H; y0 += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, H - y0)
    const s = new Uint16Array(rows * W * 3)
    // Horizontal differencing per channel, as TIFF predictor 2 defines it for 16-bit samples.
    for (let r = 0; r < rows; r++) {
      const src = (y0 + r) * W * 3
      const dst = r * W * 3
      for (let i = 0; i < 3; i++) s[dst + i] = data[src + i]
      for (let i = 3; i < W * 3; i++) s[dst + i] = (data[src + i] - data[src + i - 3]) & 0xffff
    }
    // Uint16Array is little-endian on every platform browsers run on, which matches the 'II' header.
    strips.push(zlibSync(new Uint8Array(s.buffer), { level: LEVEL }))
    onProgress?.((y0 + rows) / H)
    await breathe()
  }

  const SHORT = 3
  const LONG = 4
  const RATIONAL = 5
  const ASCII = 2
  const UNDEFINED = 7
  const software = new TextEncoder().encode('Imaginary\0')
  const n = strips.length
  type Entry = { tag: number; type: number; count: number; data: Uint8Array }
  const le = (type: number, values: number[]) => {
    const size = type === SHORT ? 2 : 4
    const out = new Uint8Array(values.length * size)
    const v = new DataView(out.buffer)
    values.forEach((x, i) => (size === 2 ? v.setUint16(i * 2, x, true) : v.setUint32(i * 4, x, true)))
    return out
  }
  const entries: Entry[] = [
    { tag: 256, type: LONG, count: 1, data: le(LONG, [W]) },
    { tag: 257, type: LONG, count: 1, data: le(LONG, [H]) },
    { tag: 258, type: SHORT, count: 3, data: le(SHORT, [16, 16, 16]) },
    { tag: 259, type: SHORT, count: 1, data: le(SHORT, [8]) },
    { tag: 262, type: SHORT, count: 1, data: le(SHORT, [2]) },
    { tag: 273, type: LONG, count: n, data: new Uint8Array(n * 4) }, // strip offsets, filled in below
    { tag: 274, type: SHORT, count: 1, data: le(SHORT, [1]) },
    { tag: 277, type: SHORT, count: 1, data: le(SHORT, [3]) },
    { tag: 278, type: LONG, count: 1, data: le(LONG, [rowsPerStrip]) },
    { tag: 279, type: LONG, count: n, data: le(LONG, strips.map((s) => s.length)) },
    { tag: 282, type: RATIONAL, count: 1, data: le(LONG, [72, 1]) },
    { tag: 283, type: RATIONAL, count: 1, data: le(LONG, [72, 1]) },
    { tag: 284, type: SHORT, count: 1, data: le(SHORT, [1]) },
    { tag: 296, type: SHORT, count: 1, data: le(SHORT, [2]) },
    { tag: 305, type: ASCII, count: software.length, data: software },
    { tag: 317, type: SHORT, count: 1, data: le(SHORT, [2]) },
    { tag: 34675, type: UNDEFINED, count: icc.length, data: icc },
  ]
  // Layout: header, IFD, values too big for an entry (word aligned), then the strips.
  const ifdSize = 2 + entries.length * 12 + 4
  let at = 8 + ifdSize
  const offsets = entries.map((e) => {
    if (e.data.length <= 4) return -1
    const o = at
    at += e.data.length + (e.data.length & 1)
    return o
  })
  let stripAt = at
  const stripOffsets = new DataView(entries[5].data.buffer)
  strips.forEach((s, i) => {
    stripOffsets.setUint32(i * 4, stripAt, true)
    stripAt += s.length
  })

  const head = new Uint8Array(at)
  const v = new DataView(head.buffer)
  head.set([0x49, 0x49, 42, 0])
  v.setUint32(4, 8, true)
  v.setUint16(8, entries.length, true)
  entries.forEach((e, i) => {
    const p = 10 + i * 12
    v.setUint16(p, e.tag, true)
    v.setUint16(p + 2, e.type, true)
    v.setUint32(p + 4, e.count, true)
    if (offsets[i] < 0) head.set(e.data, p + 8)
    else {
      v.setUint32(p + 8, offsets[i], true)
      head.set(e.data, offsets[i])
    }
  })
  v.setUint32(10 + entries.length * 12, 0, true)
  return new Blob([head, ...strips] as BlobPart[], { type: 'image/tiff' })
}
