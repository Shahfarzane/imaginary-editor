// Which color space an image file declares, read from its bytes: sRGB (or nothing, which means sRGB) versus any
// other profile. WebKit uploads decoded pixels to WebGL as they are, without converting them to sRGB, so a photo
// with another profile (an iPhone's Display P3) has to be color-managed by a 2D canvas first.
import { unzlibSync } from 'fflate'
import { heifColors } from './heif'

export type FileColors = 'srgb' | 'other'

const ascii = (b: Uint8Array, at: number, n = 4) => String.fromCharCode(...b.subarray(at, at + n))
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const s15f16 = (b: Uint8Array, at: number) => (u32be(b, at) | 0) / 65536

/** The color space the file declares. Unknown formats and files without a profile count as sRGB. */
export function fileColors(bytes: Uint8Array): FileColors {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegColors(bytes)
  if (ascii(bytes, 0, 8) === '\x89PNG\r\n\x1a\n') return pngColors(bytes)
  if (ascii(bytes, 0) === 'RIFF' && ascii(bytes, 8) === 'WEBP') return webpColors(bytes)
  if (ascii(bytes, 4) === 'ftyp') return heifColors(bytes) === 'srgb' ? 'srgb' : 'other'
  return 'srgb'
}

// sRGB's colorants adapted to D50, as every sRGB ICC profile stores them.
const SRGB_COLORANTS: Record<string, [number, number, number]> = {
  rXYZ: [0.4361, 0.2225, 0.0139],
  gXYZ: [0.3851, 0.7169, 0.0971],
  bXYZ: [0.1431, 0.0606, 0.7141],
}

/** An ICC profile is sRGB when its colorants are sRGB's and its tone curve is not a plain gamma or linear one. */
export function iccColors(icc: Uint8Array): FileColors {
  if (icc.length < 132 || ascii(icc, 16) !== 'RGB ') return 'other'
  const tags = new Map<string, number>()
  const count = u32be(icc, 128)
  for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.length; i++) tags.set(ascii(icc, 132 + i * 12), u32be(icc, 132 + i * 12 + 4))
  for (const [tag, want] of Object.entries(SRGB_COLORANTS)) {
    const at = tags.get(tag)
    if (at === undefined || at + 20 > icc.length || ascii(icc, at) !== 'XYZ ') return 'other'
    for (let k = 0; k < 3; k++) if (Math.abs(s15f16(icc, at + 8 + k * 4) - want[k]) > 0.005) return 'other'
  }
  const trc = tags.get('rTRC')
  if (trc === undefined || trc + 12 > icc.length) return 'other'
  // 'curv' with no entries is linear and with one is a pure gamma; sRGB is a table or a parametric curve.
  if (ascii(icc, trc) === 'curv' && u32be(icc, trc + 8) <= 1) return 'other'
  return 'srgb'
}

function jpegColors(b: Uint8Array): FileColors {
  const chunks: { seq: number; data: Uint8Array }[] = []
  for (let at = 2; at + 4 <= b.length && b[at] === 0xff; ) {
    const marker = b[at + 1]
    if (marker === 0xda || marker === 0xd9) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2
      continue
    }
    const len = u16be(b, at + 2)
    if (marker === 0xe2 && ascii(b, at + 4, 12) === 'ICC_PROFILE\0') chunks.push({ seq: b[at + 16], data: b.subarray(at + 18, at + 2 + len) })
    at += 2 + len
  }
  if (!chunks.length) return 'srgb'
  chunks.sort((x, y) => x.seq - y.seq)
  const icc = new Uint8Array(chunks.reduce((n, c) => n + c.data.length, 0))
  chunks.reduce((at, c) => (icc.set(c.data, at), at + c.data.length), 0)
  return iccColors(icc)
}

function pngColors(b: Uint8Array): FileColors {
  for (let at = 8; at + 8 <= b.length; ) {
    const len = u32be(b, at)
    const type = ascii(b, at + 4)
    const data = b.subarray(at + 8, at + 8 + len)
    if (type === 'IDAT' || type === 'IEND') break
    if (type === 'sRGB') return 'srgb'
    // Coding-independent code points: primaries 1 with the sRGB transfer (13) is sRGB.
    if (type === 'cICP') return data[0] === 1 && data[1] === 13 ? 'srgb' : 'other'
    if (type === 'iCCP') {
      const name = data.indexOf(0)
      try {
        return iccColors(unzlibSync(data.subarray(name + 2)))
      } catch {
        return 'srgb'
      }
    }
    at += 12 + len
  }
  return 'srgb'
}

function webpColors(b: Uint8Array): FileColors {
  for (let at = 12; at + 8 <= b.length; ) {
    const len = u32le(b, at + 4)
    if (ascii(b, at) === 'ICCP') return iccColors(b.subarray(at + 8, at + 8 + len))
    at += 8 + len + (len & 1)
  }
  return 'srgb'
}
