import { describe, expect, it } from 'vite-plus/test'
import { zlibSync } from 'fflate'
import { fileColors, iccColors } from './profile'

const text = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i))
const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
const u32le = (v: number) => u32(v).reverse()
const s15 = (v: number) => u32(Math.round(v * 65536) >>> 0)

const SRGB = { r: [0.4361, 0.2225, 0.0139], g: [0.3851, 0.7169, 0.0971], b: [0.1431, 0.0606, 0.7141] }
const P3 = { r: [0.5151, 0.2412, -0.0011], g: [0.292, 0.6922, 0.0419], b: [0.1571, 0.0666, 0.7841] }

// An RGB ICC profile: three colorant tags and a red tone curve with `curvCount` entries.
function icc(c: typeof SRGB, curvCount = 1024, space = 'RGB ') {
  const tags: [string, number[]][] = [
    ['rXYZ', [...text('XYZ '), 0, 0, 0, 0, ...c.r.flatMap(s15)]],
    ['gXYZ', [...text('XYZ '), 0, 0, 0, 0, ...c.g.flatMap(s15)]],
    ['bXYZ', [...text('XYZ '), 0, 0, 0, 0, ...c.b.flatMap(s15)]],
    ['rTRC', [...text('curv'), 0, 0, 0, 0, ...u32(curvCount), ...Array.from({ length: curvCount * 2 }, () => 0)]],
  ]
  const header = Array.from({ length: 128 }, () => 0)
  header.splice(16, 4, ...text(space))
  const table: number[] = [...u32(tags.length)]
  const data: number[] = []
  let at = 128 + 4 + tags.length * 12
  for (const [sig, body] of tags) {
    table.push(...text(sig), ...u32(at), ...u32(body.length))
    data.push(...body)
    at += body.length
  }
  return new Uint8Array([...header, ...table, ...data])
}

const jpeg = (profile: Uint8Array | null, split = 1) => {
  const segs: number[] = [0xff, 0xd8, 0xff, 0xe0, 0, 16, ...text('JFIF\0'), ...Array.from({ length: 9 }, () => 0)]
  if (profile) {
    const size = Math.ceil(profile.length / split)
    for (let i = 0; i < split; i++) {
      const part = Array.from(profile.subarray(i * size, (i + 1) * size))
      const body = [...text('ICC_PROFILE\0'), i + 1, split, ...part]
      segs.push(0xff, 0xe2, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body)
    }
  }
  return new Uint8Array([...segs, 0xff, 0xda, 0, 2, 0xff, 0xd9])
}

const png = (...chunks: [string, number[]][]) =>
  new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunks.flatMap(([type, data]) => [...u32(data.length), ...text(type), ...data, 0, 0, 0, 0]),
    ...u32(0), ...text('IEND'), 0, 0, 0, 0,
  ])

describe('file color profiles', () => {
  it('tells an sRGB ICC profile from Display P3, a plain gamma and a gray one', () => {
    expect(iccColors(icc(SRGB))).toBe('srgb')
    expect(iccColors(icc(P3))).toBe('other')
    expect(iccColors(icc(SRGB, 1))).toBe('other')
    expect(iccColors(icc(SRGB, 1024, 'GRAY'))).toBe('other')
  })

  it('reads JPEG profiles, also split over several APP2 segments', () => {
    expect(fileColors(jpeg(null))).toBe('srgb')
    expect(fileColors(jpeg(icc(SRGB)))).toBe('srgb')
    expect(fileColors(jpeg(icc(P3)))).toBe('other')
    expect(fileColors(jpeg(icc(P3), 3))).toBe('other')
  })

  it('reads PNG sRGB, cICP and compressed iCCP chunks', () => {
    expect(fileColors(png())).toBe('srgb')
    expect(fileColors(png(['sRGB', [0]]))).toBe('srgb')
    expect(fileColors(png(['cICP', [1, 13, 0, 1]]))).toBe('srgb')
    expect(fileColors(png(['cICP', [12, 13, 0, 1]]))).toBe('other')
    const iccp = (p: Uint8Array) => ['iCCP', [...text('Display P3'), 0, 0, ...zlibSync(p)]] as [string, number[]]
    expect(fileColors(png(iccp(icc(P3))))).toBe('other')
    expect(fileColors(png(iccp(icc(SRGB))))).toBe('srgb')
  })

  it('reads a WebP ICCP chunk and leaves unknown bytes as sRGB', () => {
    const p = Array.from(icc(P3))
    const body = [...text('WEBP'), ...text('VP8X'), ...u32le(10), ...Array.from({ length: 10 }, () => 0), ...text('ICCP'), ...u32le(p.length), ...p]
    expect(fileColors(new Uint8Array([...text('RIFF'), ...u32le(body.length), ...body]))).toBe('other')
    expect(fileColors(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe('srgb')
  })
})
