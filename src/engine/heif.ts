// HEIF container sniffing for the HEIC fallback decoder: is a file HEIF at all, and are its colors
// Display P3 (what iPhones write) or sRGB. Pure byte parsing, no decoder needed.

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const u16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1]
const s15f16 = (b: Uint8Array, at: number) => (u32(b, at) | 0) / 65536

// HEVC-coded HEIF brands. AVIF (also HEIF) is left to the browser, which decodes it natively.
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'])

/** True when the bytes start with an ftyp box naming an HEVC HEIF brand, major or compatible. */
export function isHeic(head: Uint8Array): boolean {
  if (head.length < 16 || ascii(head, 4) !== 'ftyp') return false
  const end = Math.min(u32(head, 0), head.length)
  if (HEIC_BRANDS.has(ascii(head, 8))) return true
  for (let at = 16; at + 4 <= end; at += 4) if (HEIC_BRANDS.has(ascii(head, at))) return true
  return false
}

export type HeifColors = 'display-p3' | 'srgb'

/**
 * The color space of the first `colr` box: nclx primaries 12 is Display P3; an ICC profile counts as
 * P3 when its red colorant sits where P3's does (D50 X about 0.515, sRGB's about 0.436). No box: sRGB.
 */
export function heifColors(bytes: Uint8Array): HeifColors {
  for (let at = 4; at + 12 <= bytes.length; at++) {
    if (bytes[at] !== 0x63 || ascii(bytes, at) !== 'colr') continue
    const size = u32(bytes, at - 4)
    const kind = ascii(bytes, at + 4)
    if (kind === 'nclx') return u16(bytes, at + 8) === 12 ? 'display-p3' : 'srgb'
    if (kind === 'prof' || kind === 'rICC') return iccIsP3(bytes.subarray(at + 8, at - 4 + size)) ? 'display-p3' : 'srgb'
  }
  return 'srgb'
}

function iccIsP3(icc: Uint8Array): boolean {
  if (icc.length < 132) return false
  const count = u32(icc, 128)
  for (let i = 0; i < count && 132 + i * 12 + 12 <= icc.length; i++) {
    const t = 132 + i * 12
    if (ascii(icc, t) !== 'rXYZ') continue
    const off = u32(icc, t + 4)
    // An XYZ tag: 'XYZ ', 4 reserved bytes, then X, Y, Z as s15.16.
    return off + 12 <= icc.length && s15f16(icc, off + 8) > 0.48
  }
  return false
}
