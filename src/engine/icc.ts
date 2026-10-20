// ICC v4 display profiles for the 16-bit encoders, built here from the color spaces' published primaries and the
// sRGB transfer curve (no vendor profile is copied): matrix/TRC profiles, colorants adapted to D50 with Bradford.
import { adaptation, D65_XYZ, mul, P3_PRIMARIES, primariesToXyz, SRGB_PRIMARIES, type Primaries, type Vec3 } from './color'

export type ProfileSpace = 'srgb' | 'display-p3'

// The ICC profile connection space's D50, as the spec writes it.
const D50: Vec3 = [0.9642, 1, 0.8249]

const SPACES: Record<ProfileSpace, { name: string; primaries: Primaries }> = {
  srgb: { name: 'sRGB (Imaginary)', primaries: SRGB_PRIMARIES },
  'display-p3': { name: 'Display P3 (Imaginary)', primaries: P3_PRIMARIES },
}

class Writer {
  bytes: number[] = []
  u8 = (v: number) => this.bytes.push(v & 255)
  u16 = (v: number) => (this.u8(v >> 8), this.u8(v))
  u32 = (v: number) => (this.u16(v >>> 16), this.u16(v & 0xffff))
  s15 = (v: number) => this.u32(Math.round(v * 65536) >>> 0)
  text = (s: string) => {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i))
  }
  pad = () => {
    while (this.bytes.length % 4) this.u8(0)
  }
}

function mluc(text: string) {
  const w = new Writer()
  w.text('mluc')
  w.u32(0)
  w.u32(1)
  w.u32(12)
  w.text('enUS')
  w.u32(text.length * 2)
  w.u32(28)
  for (let i = 0; i < text.length; i++) w.u16(text.charCodeAt(i))
  return w.bytes
}

function xyz(v: Vec3) {
  const w = new Writer()
  w.text('XYZ ')
  w.u32(0)
  v.forEach(w.s15)
  return w.bytes
}

const cache = new Map<ProfileSpace, Uint8Array>()

/** The profile's bytes. */
export function iccProfile(space: ProfileSpace): Uint8Array {
  const hit = cache.get(space)
  if (hit) return hit
  const { name, primaries } = SPACES[space]
  const chad = adaptation(D65_XYZ, D50)
  const m = mul(chad, primariesToXyz(...primaries))
  const col = (k: number): Vec3 => [m[k], m[3 + k], m[6 + k]]

  const sf32 = new Writer()
  sf32.text('sf32')
  sf32.u32(0)
  chad.forEach(sf32.s15)

  // sRGB's curve as parametric type 3: Y = (aX + b)^g above d, cX below.
  const para = new Writer()
  para.text('para')
  para.u32(0)
  para.u16(3)
  para.u16(0)
  ;[2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045].forEach(para.s15)

  const tags: [string, number[]][] = [
    ['desc', mluc(name)],
    ['cprt', mluc('No copyright, use freely')],
    ['wtpt', xyz(D50)],
    ['chad', sf32.bytes],
    ['rXYZ', xyz(col(0))],
    ['gXYZ', xyz(col(1))],
    ['bXYZ', xyz(col(2))],
    ['rTRC', para.bytes],
  ]
  // gTRC and bTRC share the red curve's data.
  const table = tags.length + 2
  const body = new Writer()
  const entries: [string, number, number][] = []
  let at = 128 + 4 + table * 12
  for (const [sig, data] of tags) {
    entries.push([sig, at, data.length])
    body.bytes.push(...data)
    body.pad()
    at = 128 + 4 + table * 12 + body.bytes.length
  }
  const trc = entries[entries.length - 1]
  entries.push(['gTRC', trc[1], trc[2]], ['bTRC', trc[1], trc[2]])
  const size = 128 + 4 + table * 12 + body.bytes.length

  const h = new Writer()
  h.u32(size)
  h.u32(0)
  h.u32(0x04300000)
  h.text('mntrRGB XYZ ')
  ;[2026, 1, 1, 0, 0, 0].forEach(h.u16)
  h.text('acsp')
  for (let i = 0; i < 6; i++) h.u32(0) // platform, flags, manufacturer, model, attributes
  h.u32(0) // perceptual intent
  D50.forEach(h.s15)
  for (let i = 0; i < 5; i++) h.u32(0) // creator, profile ID (not computed)
  for (let i = 0; i < 7; i++) h.u32(0) // reserved
  h.u32(table)
  for (const [sig, off, len] of entries) {
    h.text(sig)
    h.u32(off)
    h.u32(len)
  }
  const out = new Uint8Array([...h.bytes, ...body.bytes])
  cache.set(space, out)
  return out
}
