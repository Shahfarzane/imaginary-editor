import { describe, expect, it } from 'vite-plus/test'
import { heifColors, isHeic } from './heif'

const text = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i))
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const box = (type: string, body: number[]) => [...u32(8 + body.length), ...text(type), ...body]
const ftyp = (major: string, ...compatible: string[]) => box('ftyp', [...text(major), 0, 0, 0, 0, ...compatible.flatMap(text)])
const bytes = (...parts: number[][]) => new Uint8Array(parts.flat())

// An ICC profile with only a red colorant tag, X in D50 as s15.16.
function icc(redX: number) {
  const out = Array.from({ length: 132 + 12 + 20 }, () => 0)
  out.splice(128, 4, ...u32(1))
  out.splice(132, 12, ...text('rXYZ'), ...u32(144), ...u32(20))
  out.splice(144, 12, ...text('XYZ '), 0, 0, 0, 0, ...u32(Math.round(redX * 65536)))
  return out
}

describe('HEIF sniffing', () => {
  it('knows HEIC by its major or a compatible brand, and leaves AVIF and JPEG alone', () => {
    expect(isHeic(bytes(ftyp('heic', 'mif1', 'heic')))).toBe(true)
    expect(isHeic(bytes(ftyp('mif1', 'miaf', 'heic')))).toBe(true)
    expect(isHeic(bytes(ftyp('avif', 'mif1', 'miaf')))).toBe(false)
    expect(isHeic(bytes([0xff, 0xd8, 0xff, 0xe1], Array.from({ length: 28 }, () => 0)))).toBe(false)
  })

  it('reads Display P3 or sRGB from an nclx or ICC colr box', () => {
    const nclx = (primaries: number) => box('colr', [...text('nclx'), 0, primaries, 0, 13, 0, 6, 0x80])
    expect(heifColors(bytes(ftyp('heic'), nclx(12)))).toBe('display-p3')
    expect(heifColors(bytes(ftyp('heic'), nclx(1)))).toBe('srgb')
    expect(heifColors(bytes(ftyp('heic'), box('colr', [...text('prof'), ...icc(0.5151)])))).toBe('display-p3')
    expect(heifColors(bytes(ftyp('heic'), box('colr', [...text('prof'), ...icc(0.4361)])))).toBe('srgb')
    expect(heifColors(bytes(ftyp('heic')))).toBe('srgb')
  })
})
