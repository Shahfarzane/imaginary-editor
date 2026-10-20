import { describe, expect, it } from 'vite-plus/test'
import { unzlibSync } from 'fflate'
import { crc32, encodePng16, encodeTiff16, type Pixels16 } from './encode'

function pixels(width: number, height: number): Pixels16 {
  const data = new Uint16Array(width * height * 3)
  let s = 12345
  for (let i = 0; i < data.length; i++) {
    // Smooth ramps plus noise in the low bits, like a photo.
    s = (s * 1103515245 + 12345) >>> 0
    data[i] = ((i % (width * 3)) * 97 + Math.floor(i / (width * 3)) * 211 + (s >>> 22)) & 0xffff
  }
  return { width, height, data }
}

const text = (b: Uint8Array, at: number, n = 4) => String.fromCharCode(...b.subarray(at, at + n))

describe('16-bit PNG', () => {
  it('decodes back to the same samples, with valid CRCs and the profile in iCCP', async () => {
    const px = pixels(37, 150)
    const icc = new Uint8Array([1, 2, 3, 4, 5])
    const b = new Uint8Array(await (await encodePng16(px, icc, 'sRGB')).arrayBuffer())
    const v = new DataView(b.buffer)
    const idat: Uint8Array[] = []
    const types: string[] = []
    for (let at = 8; at < b.length; ) {
      const len = v.getUint32(at)
      const type = text(b, at + 4)
      types.push(type)
      expect((crc32(b.subarray(at + 4, at + 8 + len)) ^ 0xffffffff) >>> 0, type).toBe(v.getUint32(at + 8 + len))
      const data = b.subarray(at + 8, at + 8 + len)
      if (type === 'IHDR') expect([v.getUint32(at + 8), v.getUint32(at + 12), data[8], data[9]]).toEqual([37, 150, 16, 2])
      if (type === 'iCCP') expect(Array.from(unzlibSync(data.subarray(data.indexOf(0) + 2)))).toEqual([1, 2, 3, 4, 5])
      if (type === 'IDAT') idat.push(data)
      at += 12 + len
    }
    expect(types[0]).toBe('IHDR')
    expect(types.at(-1)).toBe('IEND')
    const z = new Uint8Array(idat.reduce((n, c) => n + c.length, 0))
    idat.reduce((at, c) => (z.set(c, at), at + c.length), 0)
    const raw = unzlibSync(z)
    const stride = 37 * 6
    let prev = new Uint8Array(stride)
    for (let y = 0; y < 150; y++) {
      const f = raw[y * (stride + 1)]
      expect(f).toBe(4)
      const row = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1))
      for (let i = 0; i < stride; i++) {
        const a = i >= 6 ? row[i - 6] : 0
        const bb = prev[i]
        const c = i >= 6 ? prev[i - 6] : 0
        const p = a + bb - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - bb)
        const pc = Math.abs(p - c)
        row[i] = (row[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? bb : c)) & 255
      }
      for (let i = 0; i < 37 * 3; i++) expect((row[i * 2] << 8) | row[i * 2 + 1]).toBe(px.data[y * 37 * 3 + i])
      prev = row
    }
  })
})

describe('16-bit TIFF', () => {
  it('decodes back to the same samples across several strips, with the profile in tag 34675', async () => {
    const px = pixels(4000, 100)
    const icc = new Uint8Array(Array.from({ length: 333 }, (_, i) => i & 255))
    const b = new Uint8Array(await (await encodeTiff16(px, icc)).arrayBuffer())
    const v = new DataView(b.buffer)
    expect(text(b, 0, 2)).toBe('II')
    expect(v.getUint16(2, true)).toBe(42)
    const ifd = v.getUint32(4, true)
    const tags = new Map<number, { type: number; count: number; at: number }>()
    for (let i = 0; i < v.getUint16(ifd, true); i++) {
      const p = ifd + 2 + i * 12
      tags.set(v.getUint16(p, true), { type: v.getUint16(p + 2, true), count: v.getUint32(p + 4, true), at: p + 8 })
    }
    const val = (tag: number, k = 0) => {
      const t = tags.get(tag)!
      const size = t.type === 3 ? 2 : 4
      const at = t.count * size > 4 ? v.getUint32(t.at, true) : t.at
      return size === 2 ? v.getUint16(at + k * 2, true) : v.getUint32(at + k * 4, true)
    }
    expect([val(256), val(257), val(258, 2), val(259), val(262), val(277), val(317)]).toEqual([4000, 100, 16, 8, 2, 3, 2])
    const iccTag = tags.get(34675)!
    expect(Array.from(b.subarray(v.getUint32(iccTag.at, true), v.getUint32(iccTag.at, true) + iccTag.count))).toEqual(Array.from(icc))
    const strips = tags.get(273)!.count
    expect(strips).toBeGreaterThan(1)
    const rowsPer = val(278)
    for (let s = 0; s < strips; s++) {
      const raw = unzlibSync(b.subarray(val(273, s), val(273, s) + val(279, s)))
      const u = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2)
      const rows = u.length / (4000 * 3)
      for (let r = 0; r < rows; r++) {
        const o = r * 4000 * 3
        for (let i = 3; i < 4000 * 3; i++) u[o + i] = (u[o + i] + u[o + i - 3]) & 0xffff
      }
      const start = s * rowsPer * 4000 * 3
      expect(Array.from(u.subarray(0, 600))).toEqual(Array.from(px.data.subarray(start, start + 600)))
      expect(u.every((x, i) => x === px.data[start + i])).toBe(true)
    }
  })
})
