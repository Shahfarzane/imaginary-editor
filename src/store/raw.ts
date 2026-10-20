import type LibRaw from 'libraw-wasm'
import type { PhotoInfo } from '../model/photoInfo'
import { rawInfo } from './rawInfo'
import { linearImage, spans, toHalf, type LinearImage } from '../engine/linear'
import { REC2020_TO_SRGB } from '../engine/color'

// Camera RAW decoding with LibRaw (WebAssembly, in its own worker), loaded with the first RAW file: the camera's
// white balance and color matrix into Rec. 2020 primaries at 16 bits (wide enough for what cameras record), no
// auto-brightening, then linear sRGB as half floats for the GPU, components beyond sRGB kept (negative). libraw-wasm 1.6 ignores the gamma setting and always encodes with dcraw's default
// BT.709 curve (power 0.45, toe slope 4.5), which is undone here to get linear light.


const two = (n: number) => String(n).padStart(2, '0')

/** The photo's pixels. Asked for no more than `maxEdge` on the long side, half-size decoding (four times fewer
 * pixels, no demosaic) is used when that still covers it, and the rest is area-averaged down to `maxEdge`. */
export async function decodeRaw(blob: Blob, maxEdge?: number): Promise<LinearImage> {
  const { default: LibRawClass } = await import('libraw-wasm')
  const raw: LibRaw = new LibRawClass()
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const settings = { useCameraWb: true, useCameraMatrix: 1, outputColor: 8, outputBps: 16, noAutoBright: true, userQual: 3 }
    // Half size is the full image's width and height halved; a full decode only when that falls short.
    let enough = false
    if (maxEdge) {
      await raw.open(bytes.slice(), { ...settings, halfSize: true })
      const size = await raw.metadata()
      enough = !!size && Math.max(size.width, size.height) / 2 >= maxEdge
    }
    if (!enough) await raw.open(bytes, settings)
    const m = await raw.metadata()
    if (m) rawInfo.set(blob, infoOf(m))
    const img = await raw.imageData()
    if (!img || img.colors !== 3 || img.bits <= 8) throw new Error('LibRaw returned no 16-bit RGB image')
    const data = img.data as Uint16Array
    const curve = await cameraCurve(raw, data)
    return toLinear(data, img.width, img.height, curve, maxEdge)
  } finally {
    raw.dispose()
  }
}

type Meta = NonNullable<Awaited<ReturnType<LibRaw['metadata']>>>

function infoOf(m: Meta): Partial<PhotoInfo> {
  const t = m.timestamp instanceof Date && m.timestamp.getTime() > 0 ? m.timestamp : null
  return {
    make: m.camera_make || undefined,
    model: m.camera_model || undefined,
    lens: m.lens?.Lens || undefined,
    focalLength: m.focal_len || undefined,
    fNumber: m.aperture || undefined,
    exposureTime: m.shutter || undefined,
    iso: m.iso_speed || undefined,
    // The camera's clock, as LibRaw reads it.
    taken: t ? `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}` : undefined,
  }
}

// ------------------------------------------------------------------ the camera's rendering

const LUMA = [0.2126, 0.7152, 0.0722]
// The same luminance from Rec. 2020 values.
const LUMA_2020 = [0.2627, 0.678, 0.0593]
const BINS = 4096
/** Linear luminance bins run in log2 from 2^-14 to 1. */
const binOf = (y: number) => Math.max(0, Math.min(BINS - 1, Math.floor(((Math.log2(Math.max(y, 2 ** -14)) + 14) / 14) * (BINS - 1))))
const yOf = (bin: number) => 2 ** ((bin / (BINS - 1)) * 14 - 14)
/** The curve at luminance y, interpolated between bins so it never steps. */
function curveAt(curve: Float32Array, y: number) {
  const p = Math.max(0, Math.min(BINS - 1, ((Math.log2(Math.max(y, 2 ** -14)) + 14) / 14) * (BINS - 1)))
  const i = Math.min(BINS - 2, Math.floor(p))
  const f = p - i
  return curve[i] + (curve[i + 1] - curve[i]) * f
}

/**
 * The camera's own tone and exposure, read off the preview it embedded in the file: a curve on linear luminance
 * that gives the decoded photo the preview's brightness distribution (their histograms matched). Hue and
 * saturation stay the decode's; only luminance moves. Without a JPEG preview the photo stays as decoded.
 */
async function cameraCurve(raw: LibRaw, data: Uint16Array): Promise<Float32Array | null> {
  let preview: ImageBitmap
  try {
    const t = await raw.thumbnailData()
    if (!t?.data || (t as { format?: string }).format && (t as { format?: string }).format !== 'jpeg') return null
    preview = await createImageBitmap(new Blob([t.data as BlobPart], { type: 'image/jpeg' }))
  } catch {
    return null
  }
  // The preview's luminance histogram, at up to 512 px.
  const k = Math.min(1, 512 / Math.max(preview.width, preview.height))
  const c = new OffscreenCanvas(Math.max(1, Math.round(preview.width * k)), Math.max(1, Math.round(preview.height * k)))
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(preview, 0, 0, c.width, c.height)
  preview.close()
  const p = g.getImageData(0, 0, c.width, c.height).data
  const dec = srgbDecodeTable()
  const target = new Float64Array(BINS)
  for (let i = 0; i < p.length; i += 4) target[binOf(LUMA[0] * dec[p[i]] + LUMA[1] * dec[p[i + 1]] + LUMA[2] * dec[p[i + 2]])]++
  // The decode's, on every 7th pixel.
  const lin = bt709Table()
  const ours = new Float64Array(BINS)
  for (let i = 0; i < data.length; i += 21) ours[binOf(LUMA_2020[0] * lin[data[i]] + LUMA_2020[1] * lin[data[i + 1]] + LUMA_2020[2] * lin[data[i + 2]])]++
  // Match the cumulative distributions: each of our bins to the preview's luminance at the same rank.
  const cdf = (h: Float64Array) => {
    const out = new Float64Array(BINS)
    let sum = 0
    const total = h.reduce((a, b) => a + b, 0)
    for (let i = 0; i < BINS; i++) out[i] = (sum += h[i]) / total
    return out
  }
  const co = cdf(ours)
  const ct = cdf(target)
  const curve = new Float32Array(BINS)
  let j = 0
  for (let i = 0; i < BINS; i++) {
    while (j < BINS - 1 && ct[j] < co[i]) j++
    curve[i] = yOf(j)
  }
  // Smooth over a sixteenth of an octave either side and keep it rising.
  const out = new Float32Array(BINS)
  const r = Math.round(BINS / 14 / 16)
  for (let i = 0; i < BINS; i++) {
    let s = 0
    let n = 0
    for (let d = -r; d <= r; d++) {
      const q = i + d
      if (q >= 0 && q < BINS) {
        s += Math.log2(curve[q])
        n++
      }
    }
    out[i] = Math.max(i ? out[i - 1] : 0, 2 ** (s / n))
  }
  return out
}

let bt709: Float32Array | null = null
const bt709Table = () => (bt709 ??= Float32Array.from({ length: 65536 }, (_, v) => fromBt709(v / 65535)))
let srgbDec: Float32Array | null = null
const srgbDecodeTable = () =>
  (srgbDec ??= Float32Array.from({ length: 256 }, (_, v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }))

/** Linear light from LibRaw's BT.709-encoded output. */
export const fromBt709 = (v: number) => (v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45))

/**
 * LibRaw's 16-bit Rec. 2020 RGB (BT.709 curve) to linear sRGB half floats through the camera's curve (luminance scaled, hue kept),
 * area-averaged down to `maxEdge`. Channels above white are kept for Highlights to recover; the renderer clamps
 * what remains at white, so at full size every look renders exactly as before.
 */
function toLinear(data: Uint16Array, width: number, height: number, curve: Float32Array | null, maxEdge?: number): LinearImage {
  const lin = bt709Table()
  const M = REC2020_TO_SRGB
  const k = maxEdge ? Math.min(1, maxEdge / Math.max(width, height)) : 1
  const W = Math.max(1, Math.round(width * k))
  const H = Math.max(1, Math.round(height * k))
  const out = new Uint16Array(W * H * 4)
  const one = toHalf(1)
  const px = (i: number, rgb: Float32Array) => {
    const R = lin[data[i]]
    const G = lin[data[i + 1]]
    const B = lin[data[i + 2]]
    let r = M[0] * R + M[1] * G + M[2] * B
    let g = M[3] * R + M[4] * G + M[5] * B
    let b = M[6] * R + M[7] * G + M[8] * B
    if (curve) {
      const Y = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b
      const s = Y > 0 ? curveAt(curve, Y) / Y : 1
      r *= s
      g *= s
      b *= s
    }
    // Channels above white stay (up to 6, inside the LUT shaper's range): the renderer clamps them at white after
    // Highlights and Shadows, which can bring them back. Negative components (beyond sRGB) stay too.
    rgb[0] = Math.min(r, 6)
    rgb[1] = Math.min(g, 6)
    rgb[2] = Math.min(b, 6)
  }
  const rgb = new Float32Array(3)
  if (W === width && H === height) {
    for (let i = 0, o = 0; o < out.length; i += 3, o += 4) {
      px(i, rgb)
      out[o] = toHalf(rgb[0])
      out[o + 1] = toHalf(rgb[1])
      out[o + 2] = toHalf(rgb[2])
      out[o + 3] = one
    }
    return linearImage(W, H, out)
  }
  // Separable area average in linear light: each input row is spread over its output columns, then over its rows.
  const xs = spans(width, W)
  const ys = spans(height, H)
  const acc = new Float32Array(W * H * 3)
  const row = new Float32Array(W * 3)
  for (let y = 0; y < height; y++) {
    row.fill(0)
    for (let x = 0; x < width; x++) {
      px((y * width + x) * 3, rgb)
      const o = xs.to[x] * 3
      for (let c = 0; c < 3; c++) {
        row[o + c] += rgb[c] * xs.w0[x]
        if (xs.w1[x]) row[o + 3 + c] += rgb[c] * xs.w1[x]
      }
    }
    const o0 = ys.to[y] * W * 3
    for (let j = 0; j < W * 3; j++) acc[o0 + j] += row[j] * ys.w0[y]
    if (ys.w1[y]) for (let j = 0; j < W * 3; j++) acc[o0 + W * 3 + j] += row[j] * ys.w1[y]
  }
  for (let i = 0, o = 0; o < out.length; i += 3, o += 4) {
    out[o] = toHalf(acc[i])
    out[o + 1] = toHalf(acc[i + 1])
    out[o + 2] = toHalf(acc[i + 2])
    out[o + 3] = one
  }
  return linearImage(W, H, out)
}
