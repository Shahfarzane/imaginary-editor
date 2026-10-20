// Sources finer than 8 bits (camera RAW): linear-light RGB kept as half floats, uploaded to the GPU as RGBA16F so
// shadows and smooth gradients keep the decoder's precision instead of 256 sRGB levels.
import { linearToSrgb } from './color'

/** Linear-light sRGB-primaries pixels as half floats, RGBA with alpha 1, top row first. */
export interface LinearImage {
  readonly linear: true
  readonly width: number
  readonly height: number
  data: Uint16Array
  close(): void
}

export const isLinear = (p: object): p is LinearImage => 'linear' in p

export function linearImage(width: number, height: number, data: Uint16Array): LinearImage {
  return {
    linear: true,
    width,
    height,
    data,
    close() {
      this.data = new Uint16Array(0)
    },
  }
}

const f32 = new Float32Array(1)
const bits = new Uint32Array(f32.buffer)

/** A float to IEEE half bits, rounded to nearest. Inputs here are finite: linear light, up to a few times white. */
export function toHalf(v: number): number {
  f32[0] = v
  const x = bits[0]
  const sign = (x >>> 16) & 0x8000
  const e = ((x >>> 23) & 0xff) - 112
  const m = x & 0x7fffff
  if (e >= 31) return sign | 0x7c00
  if (e <= 0) return e < -10 ? sign : sign | ((((m | 0x800000) >> (1 - e)) + 0x1000) >> 13)
  return sign | ((e << 10) + ((m + 0x1000) >> 13))
}

let halves: Float32Array | null = null
/** Half bits to float, as a table over all 65536 patterns. */
export const halfTable = () =>
  (halves ??= Float32Array.from({ length: 65536 }, (_, h) => {
    const s = h & 0x8000 ? -1 : 1
    const e = (h >> 10) & 31
    const m = h & 1023
    if (e === 0) return s * m * 2 ** -24
    if (e === 31) return m ? NaN : s * Infinity
    return s * (1 + m / 1024) * 2 ** (e - 15)
  }))

/**
 * Area resampling from n to N samples (N <= n): for input index i, its first output `to[i]` with weight `w0[i]`
 * and the next output with `w1[i]` (an input straddles at most two outputs). Weights are normalized per output.
 */
export function spans(n: number, N: number) {
  const s = n / N
  const to = new Uint32Array(n)
  const w0 = new Float32Array(n)
  const w1 = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const j = Math.min(N - 1, Math.floor(i / s))
    const edge = (j + 1) * s
    to[i] = j
    if (i + 1 > edge && j + 1 < N) {
      w0[i] = (edge - i) / s
      w1[i] = (i + 1 - edge) / s
    } else w0[i] = 1 / s
  }
  return { to, w0, w1 }
}

/** A linear image area-averaged to at most `maxEdge` on its long edge, in linear light: RGB floats per pixel. */
function areaAverage(img: LinearImage, maxEdge: number): { W: number; H: number; acc: Float32Array } {
  const { width: w, height: h } = img
  const k = Math.min(1, maxEdge / Math.max(w, h))
  const W = Math.max(1, Math.round(w * k))
  const H = Math.max(1, Math.round(h * k))
  const half = halfTable()
  const xs = spans(w, W)
  const ys = spans(h, H)
  const acc = new Float32Array(W * H * 3)
  for (let y = 0; y < h; y++) {
    const oy0 = ys.to[y] * W * 3
    const oy1 = oy0 + W * 3
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const ox = xs.to[x] * 3
      for (let c = 0; c < 3; c++) {
        const v = half[img.data[i + c]]
        const a = v * xs.w0[x]
        const b = v * xs.w1[x]
        acc[oy0 + ox + c] += a * ys.w0[y]
        if (xs.w1[x]) acc[oy0 + ox + 3 + c] += b * ys.w0[y]
        if (ys.w1[y]) {
          acc[oy1 + ox + c] += a * ys.w1[y]
          if (xs.w1[x]) acc[oy1 + ox + 3 + c] += b * ys.w1[y]
        }
      }
    }
  }
  return { W, H, acc }
}

/** 8-bit sRGB pixels of a linear image, area-averaged to at most `maxEdge`, for thumbnails and 2D canvases. */
export function linearToImageData(img: LinearImage, maxEdge = Infinity): ImageData {
  const { W, H, acc } = areaAverage(img, maxEdge)
  const out = new ImageData(W, H)
  for (let i = 0, o = 0; i < acc.length; i += 3, o += 4) {
    out.data[o] = 255 * linearToSrgb(acc[i])
    out.data[o + 1] = 255 * linearToSrgb(acc[i + 1])
    out.data[o + 2] = 255 * linearToSrgb(acc[i + 2])
    out.data[o + 3] = 255
  }
  return out
}

/**
 * A linear image no larger than `maxEdge` on its long edge, area-averaged in linear light and kept in half floats, so
 * light above white and colors beyond sRGB survive: for a GPU that cannot take it at full size.
 */
export function downsampleLinear(img: LinearImage, maxEdge: number): LinearImage {
  if (Math.max(img.width, img.height) <= maxEdge) return img
  const { W, H, acc } = areaAverage(img, maxEdge)
  const data = new Uint16Array(W * H * 4)
  const one = toHalf(1)
  for (let i = 0, o = 0; i < acc.length; i += 3, o += 4) {
    data[o] = toHalf(acc[i])
    data[o + 1] = toHalf(acc[i + 1])
    data[o + 2] = toHalf(acc[i + 2])
    data[o + 3] = one
  }
  return linearImage(W, H, data)
}
