// CPU-side color math. Anything here that the shaders also do is mirrored
// exactly so tests can pin the behavior.

export type Vec3 = [number, number, number]
export type Mat3 = [number, number, number, number, number, number, number, number, number] // row-major

export const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
export const linearToSrgb = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055

// Log shaper for the look LUT input: linear 0..SHAPER_MAX maps to 0..1 with
// most of the precision in the shadows. The normalization is chosen so linear
// 1.0 (paper white) lands exactly on lattice point 43 of the 65^3 LUT, which
// keeps white exact even where looks clip or bend hard at 1.0.
// Must match common.glsl.
export const SHAPER_A = 64
export const SHAPER_WHITE_INDEX = 43
const SHAPER_NORM = (Math.log2(SHAPER_A + 1) * 64) / SHAPER_WHITE_INDEX
export const SHAPER_MAX = (Math.pow(2, SHAPER_NORM) - 1) / SHAPER_A
export const shaper = (lin: number) => Math.log2(Math.max(lin, 0) * SHAPER_A + 1) / SHAPER_NORM
export const shaperInv = (s: number) => (Math.pow(2, s * SHAPER_NORM) - 1) / SHAPER_A

// ---------------------------------------------------------------------------
// White balance: Planckian locus + Bradford adaptation into linear sRGB.

const XYZ_FROM_SRGB: Mat3 = [
  0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041,
]
const SRGB_FROM_XYZ: Mat3 = [
  3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252,
]
const BRADFORD: Mat3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296]
const BRADFORD_INV: Mat3 = [
  0.9869929, -0.1470543, 0.1599627, 0.4323053, 0.5183603, 0.0492912, -0.0085287, 0.0400428, 0.9684867,
]

export function mul(a: Mat3, b: Mat3): Mat3 {
  const r = Array.from({ length: 9 }, () => 0) as Mat3
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
  return r
}
export const apply = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]
export const IDENTITY3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** CIE 1931 xy of a blackbody at T kelvin (Kim et al. cubic fit, 1667K..25000K). */
export function cctToXy(T: number): [number, number] {
  T = Math.min(25000, Math.max(1667, T))
  const t = 1e3 / T
  const x =
    T <= 4000
      ? -0.2661239 * t ** 3 - 0.234358 * t ** 2 + 0.8776956 * t + 0.17991
      : -3.0258469 * t ** 3 + 2.1070379 * t ** 2 + 0.2226347 * t + 0.24039
  const y =
    T <= 2222
      ? -1.1063814 * x ** 3 - 1.3481102 * x ** 2 + 2.18555832 * x - 0.20219683
      : T <= 4000
        ? -0.9549476 * x ** 3 - 1.37418593 * x ** 2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x ** 3 - 5.8733867 * x ** 2 + 3.75112997 * x - 0.37001483
  return [x, y]
}

const xyToXYZ = (x: number, y: number): Vec3 => [x / y, 1, (1 - x - y) / y]
const D65: Vec3 = [0.95047, 1, 1.08883]

/**
 * Matrix (linear sRGB -> linear sRGB) for the Temperature and Tint sliders.
 * Positive temperature warms the picture: we pretend the scene was lit by a
 * bluer source and adapt it to D65.
 */
export function whiteBalanceMatrix(temperature: number, tint: number): Mat3 {
  if (temperature === 0 && tint === 0) return IDENTITY3
  // ±1 spans roughly 4400K..9600K around D65 (about -2000K / +3000K).
  const T = 6504 * Math.pow(2, temperature * 0.56)
  let [x, y] = cctToXy(T)
  // D65 is slightly off the Planckian locus; offset so 0 stays neutral.
  const [x0, y0] = cctToXy(6504)
  x += 0.31271 - x0
  y += 0.32902 - y0
  // Tint moves perpendicular to the locus. Like temperature, we shift the
  // assumed source the opposite way: a greener source makes a magenta picture.
  y += tint * 0.028
  x -= tint * 0.006
  const src = xyToXYZ(x, y)
  const s = apply(BRADFORD, src)
  const d = apply(BRADFORD, D65)
  const scale: Mat3 = [d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]]
  const cat = mul(BRADFORD_INV, mul(scale, BRADFORD))
  const m = mul(SRGB_FROM_XYZ, mul(cat, XYZ_FROM_SRGB))
  // Keep luminance of neutral gray roughly constant so the slider does not
  // double as an exposure control.
  const g = apply(m, [0.18, 0.18, 0.18])
  const lum = (0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]) / 0.18
  return m.map((v) => v / lum) as Mat3
}

// ---------------------------------------------------------------------------
// Display P3 sources: uploaded as P3 and turned into linear sRGB by the geometry pass. Colors outside sRGB
// come out with negative components, which the half-float working buffer keeps.

function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = f * g - d * i
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d].map((v) => v / det) as Mat3
}

export type Primaries = [[number, number], [number, number], [number, number]]
export const SRGB_PRIMARIES: Primaries = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]]
export const P3_PRIMARIES: Primaries = [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]]

/** Bradford chromatic adaptation from one white (XYZ) to another. */
export function adaptation(from: Vec3, to: Vec3): Mat3 {
  const s = apply(BRADFORD, from)
  const d = apply(BRADFORD, to)
  return mul(BRADFORD_INV, mul([d[0] / s[0], 0, 0, 0, d[1] / s[1], 0, 0, 0, d[2] / s[2]], BRADFORD))
}
export const D65_XYZ = D65

/** Linear RGB to XYZ for primaries at CIE xy, scaled so RGB white is D65. */
export function primariesToXyz(r: [number, number], g: [number, number], b: [number, number]): Mat3 {
  const col = ([x, y]: [number, number]) => [x / y, 1, (1 - x - y) / y]
  const [R, G, B] = [col(r), col(g), col(b)]
  const P: Mat3 = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]]
  const s = apply(invert(P), D65)
  return P.map((v, k) => v * s[k % 3]) as Mat3
}

/** Linear Display P3 to linear sRGB (both D65). */
export const P3_TO_SRGB: Mat3 = mul(SRGB_FROM_XYZ, primariesToXyz(...P3_PRIMARIES))
/** Linear sRGB to linear Display P3, for wide-gamut output. */
export const SRGB_TO_P3: Mat3 = invert(P3_TO_SRGB)
export const REC2020_PRIMARIES: Primaries = [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]]
/** Linear Rec. 2020 to linear sRGB, for camera RAW decoded wider than sRGB. */
export const REC2020_TO_SRGB: Mat3 = mul(SRGB_FROM_XYZ, primariesToXyz(...REC2020_PRIMARIES))

// ---------------------------------------------------------------------------
// Curves: monotone cubic (Fritsch-Carlson) through control points, sampled.

export function monotoneSpline(points: [number, number][], samples: number, domainMax = 1): Float32Array {
  const pts = [...points].sort((a, b) => a[0] - b[0])
  const out = new Float32Array(samples)
  const n = pts.length
  if (n === 0) {
    for (let i = 0; i < samples; i++) out[i] = (i / (samples - 1)) * domainMax
    return out
  }
  if (n === 1) return out.fill(pts[0][1])
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const d: number[] = []
  const m: number[] = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]))
  m.push(d[0])
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2)
  m.push(d[n - 2])
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / d[i]
    const b = m[i + 1] / d[i]
    const h = a * a + b * b
    if (h > 9) {
      const t = 3 / Math.sqrt(h)
      m[i] = t * a * d[i]
      m[i + 1] = t * b * d[i]
    }
  }
  for (let s = 0; s < samples; s++) {
    const x = (s / (samples - 1)) * domainMax
    let y: number
    if (x <= xs[0]) y = ys[0] + (x - xs[0]) * (n > 1 ? 0 : 0)
    else if (x >= xs[n - 1]) y = ys[n - 1]
    else {
      let i = 0
      while (i < n - 2 && x > xs[i + 1]) i++
      const h = xs[i + 1] - xs[i]
      const t = (x - xs[i]) / h
      const t2 = t * t
      const t3 = t2 * t
      y =
        (2 * t3 - 3 * t2 + 1) * ys[i] +
        (t3 - 2 * t2 + t) * h * m[i] +
        (-2 * t3 + 3 * t2) * ys[i + 1] +
        (t3 - t2) * h * m[i + 1]
    }
    out[s] = y
  }
  return out
}

// ---------------------------------------------------------------------------
// Film tone curve. Maps perceptual (sRGB-encoded, may exceed 1) input to
// display output per channel. Shape: normalized logistic S around a pivot,
// soft shoulder past 1.0 for headroom, then remapped into [black, white] per
// channel, which is where tinted shadows and creamy highlights come from.

export interface ToneParams {
  contrast: number // -1..1, 0 = straight
  pivot: number // input value that stays put by the S curve (0.3..0.7)
  gamma: Vec3 // per channel midtone bend, 1 = none (>1 darkens that channel's mids)
  black: Vec3 // output at input 0
  white: Vec3 // output at input 1
  headroom: number // how much extra output past input 1 (0..0.08)
  toe: number // 0..1 extra softness in deep shadows
}

export const NEUTRAL_TONE: ToneParams = {
  contrast: 0,
  pivot: 0.5,
  gamma: [1, 1, 1],
  black: [0, 0, 0],
  white: [1, 1, 1],
  headroom: 0,
  toe: 0,
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x))

/** S-curve on [0,1]: contrast > 0 steepens around pivot, < 0 flattens. Monotone. */
export function sCurve(v: number, contrast: number, pivot: number): number {
  if (Math.abs(contrast) < 1e-4) return v
  const k = Math.abs(contrast) * 9
  const l0 = logistic(-k * pivot)
  const l1 = logistic(k * (1 - pivot))
  if (contrast > 0) {
    return (logistic(k * (v - pivot)) - l0) / (l1 - l0)
  }
  // Inverse of the steepened curve flattens mids and steepens ends.
  const y = l0 + v * (l1 - l0)
  const x = Math.log(y / (1 - y)) / k + pivot
  return x
}

export const LOOK_CURVE_SIZE = 1024
export const LOOK_CURVE_DOMAIN = 2 // perceptual input range covered by the curve texture

export function toneCurve(v: number, p: ToneParams, channel: 0 | 1 | 2): number {
  const inside = Math.min(Math.max(v, 0), 1)
  let y = sCurve(inside, p.contrast, p.pivot)
  if (p.toe > 0) {
    // Soft toe: blend toward a curve that approaches black with zero slope.
    const toe = y * y * (3 - 2 * y)
    const w = p.toe * (1 - smoothstep(0, 0.35, y))
    y = y + (toe - y) * w
  }
  const g = p.gamma[channel]
  if (g !== 1) y = Math.pow(Math.max(y, 0), g)
  if (v > 1 && p.headroom > 0) {
    y = 1 + p.headroom * (1 - Math.exp(-(v - 1) * 2.5))
  }
  const b = p.black[channel]
  // Keep the channel from inverting when dims push black and white together.
  const w = Math.max(p.white[channel], b + 0.08)
  return b + (w - b) * y
}

/** y-values on evenly spaced knots over 0..1 -> control points. */
export const knotPoints = (ys: number[]): [number, number][] => ys.map((y, i) => [i / (ys.length - 1), y])

export function buildToneCurves(
  p: ToneParams,
  master?: [number, number][],
  channels?: [number[], number[], number[]],
): Float32Array {
  const out = new Float32Array(LOOK_CURVE_SIZE * 3)
  const sampled = (pts: [number, number][] | undefined) => (pts && pts.length > 1 ? monotoneSpline(pts, 1024) : null)
  const lookup = (m: Float32Array | null, y: number) => {
    if (!m) return y
    const u = Math.min(1, Math.max(0, y)) * 1023
    const i = Math.min(1022, Math.floor(u))
    return m[i] + (m[i + 1] - m[i]) * (u - i)
  }
  const m = sampled(master)
  for (let c = 0; c < 3; c++) {
    // Fitted looks carry a free curve per channel after the parametric tone.
    const ch = sampled(channels ? knotPoints(channels[c]) : undefined)
    for (let i = 0; i < LOOK_CURVE_SIZE; i++) {
      const v = (i / (LOOK_CURVE_SIZE - 1)) * LOOK_CURVE_DOMAIN
      out[c * LOOK_CURVE_SIZE + i] = lookup(ch, lookup(m, toneCurve(v, p, c as 0 | 1 | 2)))
    }
  }
  return out
}

export function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// ---------------------------------------------------------------------------
// Oklab (Björn Ottosson), used by tests and by the Match Look feature.

export function linearToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export function oklabToLinear([L, a, b]: Vec3): Vec3 {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}
