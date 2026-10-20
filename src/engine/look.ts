import {
  apply,
  NEUTRAL_TONE,
  sCurve,
  whiteBalanceMatrix,
  mul,
  type Mat3,
  type ToneParams,
  type Vec3,
} from './color'
import { HSL_BANDS, type DimId, type HslBand, type HslValue, type SplitTone } from '../model/edit'

// A "look" is the parametric film/preset model that the bake shader evaluates.
// Presets are LookParams; the Pro and Film dims move through this space.

export interface Calibration {
  // Lightroom-style primary calibration, -1..1.
  redHue: number
  redSat: number
  greenHue: number
  greenSat: number
  blueHue: number
  blueSat: number
}

export interface LookParams {
  /** White balance shift baked into the stock (-1..1 like the tool). */
  temperature: number
  tint: number
  exposure: number // stops
  calibration: Calibration
  tone: ToneParams
  mono: number // 0..1
  monoMix: Vec3 // B&W channel weights, normalized when used
  hsl: Partial<Record<HslBand, Partial<HslValue>>>
  sat: number // chroma multiplier
  satShadows: number
  satHighlights: number
  split: SplitTone
  skin: { hue: number; sat: number }
  /** Post-curve display gains, the "scanner balance" that Warmth moves. */
  scan: Vec3
  /** Texture the stock carries, added on top of the user's Effects. */
  grain: number
  grainSize: number
  halation: number
  /** Optional free-form master curve applied after the parametric tone (Match Look). */
  curve?: [number, number][]
  /** Saturated colors get darker, like subtractive film dyes (0..1.5). */
  density: number
  /** Crossover: hue rotation in shadows / highlights (-1..1, ±25°). */
  hueShadows: number
  hueHighlights: number
  /** Soft chroma roll-off toward the gamut edge (0..1). */
  chromaKnee: number
  /** Display-space crosstalk after the curves: 6 off-diagonal terms (rows keep neutrals). */
  postMatrix: [number, number, number, number, number, number]
  /** B&W mixer: per-hue-band lightness before desaturation (-1..1 each, 8 bands). */
  bwMix: number[]
  /** Free curve per channel after the parametric tone: R, G, B y-values on evenly spaced knots over 0..1. */
  channelCurves?: [number[], number[], number[]]
  /**
   * Color grid over hue x lightness x chroma (see GRID_*). Each cell holds
   * (hue shift, log chroma gain, lightness shift) in -1..1, cells ordered
   * lightness-major, then hue, then chroma. Applied after the look saturation.
   */
  grid?: number[]
  /** Same lattice as `grid`, applied to the input color before the curves (and before B&W, where it acts as the mixer). */
  gridIn?: number[]
  /** Multiplies the grid ranges of `grid` and `gridIn` per component, for looks that swap hues or move lightness far. */
  gridScale?: Vec3
  /** Distortion: display RGB through a 3x3 matrix (row-major) plus offset, clipped, before everything else (12 values). */
  rgbMatrix?: number[]
  /** Correction lattice (n^3 RGB offsets, n = LATTICE_N or up to LATTICE_MAX_N), added last and indexed by the look's input color. */
  lattice?: number[]
  /**
   * What Strength mixes the look with, where that is not the photo: the input color plus this lattice (same layout as
   * `lattice`). A B&W look's base is gray, so it stays B&W at any Strength.
   */
  strengthBase?: number[]
  /** Post stage at the end of the look; set by applyDims from a film table, or from the hand-built dims on a lattice look. */
  post?: PostStage
  /** Pro slider states blended by what they produce: the look's tail runs once per term (set by applyDims from a Pro table). */
  postTerms?: PostTerm[]
  /** The Pro states' correction lattices, mixed with the terms' weights (lattices add to the output, so mixing them is exact). */
  postLattice?: number[]
  /** Run `post` after the correction lattice instead of before it (hand-built dims on a look with a lattice). */
  postAfter?: boolean
  /** How the look's sliders move it, captured at fixed slider positions (see SliderTable). */
  sliders?: SliderTable
}

// Color grid lattice. Cells are interpolated linearly on all three axes, hue wraps.
export const GRID_L = [0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95]
export const GRID_HUES = 24
export const GRID_C = [0.02, 0.06, 0.12, 0.2]
export const GRID_CELLS = GRID_L.length * GRID_HUES * GRID_C.length
/** Full-scale cell values: degrees of hue, log chroma, Oklab lightness. */
export const GRID_RANGE: Vec3 = [45, 1.5, 0.2]

// Post stage: what a slider does to a look, as a small stage after it. Per-channel
// curves (linear between POST_KNOTS knots), chroma by lightness, and a coarse
// color grid on its own lattice.
export const POST_KNOTS = 17
export const POST_L = [0.15, 0.45, 0.75, 0.95]
export const POST_HUES = 12
export const POST_C = [0.04, 0.12]
export const POST_CELLS = POST_L.length * POST_HUES * POST_C.length
export const POST_RANGE: Vec3 = [30, 1, 0.1]

// Correction lattice: a coarse RGB table over the look's input color (display RGB), whose
// trilinear value is added to the look's output at the very end, after the post stage. Looks
// the stages above cannot express (hue swaps, distortions) and extreme slider states carry
// one. Nodes run red fastest, then green, then blue; each holds an RGB offset.
export const LATTICE_N = 9
export const LATTICE_CELLS = LATTICE_N ** 3
/**
 * Largest lattice the renderer holds: looks the 9-node lattice cannot reach carry 11 or 13 nodes per axis, and so
 * do the state lattices of film tables whose extreme corners 9 nodes miss (every state of a table the same size).
 * Lattices stay coarse on purpose: they correct a parametric look, they are not a LUT of their own.
 */
export const LATTICE_MAX_N = 13

/** Nodes per axis of a lattice, from its length (n^3 nodes, 3 offsets each). */
export const latticeN = (g: number[]) => Math.round(Math.cbrt(g.length / 3))

/** A lattice resampled to n nodes per axis by trilinear interpolation at the new nodes. */
export function resampleLattice(g: number[], n: number): number[] {
  const m = latticeN(g)
  if (m === n) return g
  const out: number[] = Array.from({ length: n * n * n * 3 }, () => 0)
  const at = (r: number, gg: number, b: number, c: number) => g[((b * m + gg) * m + r) * 3 + c]
  const axis = (k: number) => {
    const p = (k / (n - 1)) * (m - 1)
    const i = Math.min(Math.floor(p), m - 2)
    return [i, p - i] as const
  }
  for (let b = 0; b < n; b++)
    for (let gg = 0; gg < n; gg++)
      for (let r = 0; r < n; r++) {
        const [ib, fb] = axis(b)
        const [ig, fg] = axis(gg)
        const [ir, fr] = axis(r)
        for (let c = 0; c < 3; c++) {
          let v = 0
          for (let db = 0; db < 2; db++)
            for (let dg = 0; dg < 2; dg++)
              for (let dr = 0; dr < 2; dr++)
                v += (db ? fb : 1 - fb) * (dg ? fg : 1 - fg) * (dr ? fr : 1 - fr) * at(ir + dr, ig + dg, ib + db, c)
          out[((b * n + gg) * n + r) * 3 + c] = v
        }
      }
  return out
}

export interface PostStage {
  /** R, G, B curve y-values on POST_KNOTS evenly spaced knots, concatenated. */
  curves: number[]
  /** Log chroma gain: everywhere, extra in shadows, extra in highlights. */
  sat: Vec3
  /** POST_CELLS cells of (hue, log chroma, lightness), -1..1. */
  grid: number[]
  /** Optional grid on the same lattice applied to the input color before B&W conversion (B&W Color acts as a filter). */
  gridIn?: number[]
  /**
   * B&W color filter: a display-space channel mix of the look's input blended into its gray. Stored
   * premultiplied, [amount, amount x R, amount x G, amount x B weights], so stages blend linearly.
   */
  filter?: [number, number, number, number]
  /** A slider state's own correction lattice (n^3 RGB offsets, n from LATTICE_N to LATTICE_MAX_N, the same for every
   * state of a table); blends with the stage and adds to the look's. */
  lattice?: number[]
}

/**
 * Post stages captured at fixed slider positions. Film: 15 stages, Character
 * -1, -0.5, 0, 0.5, 1 (outer) by Warmth -1, 0, 1 (inner), blended bilinearly.
 * Pro: 12 stages, Contrast, Color and
 * Tone each at -1, -0.5, 0.5, 1; each slider is interpolated on its own axis and
 * the three effects add.
 */
/** One captured slider state in a blend by output; the weights of a blend sum to 1 and may be negative. */
export interface PostTerm {
  w: number
  /** The state's post stage without its lattice, or null for the look as it is (no post stage). */
  stage: PostStage | null
}

/** At most this many states blend at once: the look, the state at zero, two per slider and four combinations. */
export const MAX_POST_TERMS = 12

export interface SliderTable {
  kind: 'film' | 'pro'
  stages: PostStage[]
}

export const identityPost = (): PostStage => ({
  curves: Array.from({ length: POST_KNOTS * 3 }, (_, i) => (i % POST_KNOTS) / (POST_KNOTS - 1)),
  sat: [0, 0, 0],
  grid: Array.from({ length: POST_CELLS * 3 }, () => 0),
})

/** a + (b - a) * t for every number in a stage. */
function mixPost(a: PostStage, b: PostStage, t: number): PostStage {
  const out: PostStage = {
    curves: a.curves.map((v, i) => v + (b.curves[i] - v) * t),
    sat: a.sat.map((v, i) => v + (b.sat[i] - v) * t) as Vec3,
    grid: a.grid.map((v, i) => v + (b.grid[i] - v) * t),
  }
  if (a.gridIn || b.gridIn)
    out.gridIn = Array.from({ length: POST_CELLS * 3 }, (_, i) => (a.gridIn?.[i] ?? 0) + ((b.gridIn?.[i] ?? 0) - (a.gridIn?.[i] ?? 0)) * t)
  if (a.filter || b.filter) {
    const fa = a.filter ?? [0, 0, 0, 0]
    const fb = b.filter ?? [0, 0, 0, 0]
    out.filter = fa.map((v, i) => v + (fb[i] - v) * t) as PostStage['filter']
  }
  if (a.lattice || b.lattice) out.lattice = lerpOptional(a.lattice, b.lattice, t, (a.lattice ?? b.lattice)!.length)
  return out
}

/** Element-wise a + (b - a) * t where a missing array counts as zeros. */
function lerpOptional(a: number[] | undefined, b: number[] | undefined, t: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => (a?.[i] ?? 0) + ((b?.[i] ?? 0) - (a?.[i] ?? 0)) * t)
}

/** Position on evenly spaced slider knots: lower index and fraction. */
function knotPos(v: number, knots: number[]): [number, number] {
  const x = Math.min(Math.max(v, knots[0]), knots[knots.length - 1])
  let i = 0
  while (i < knots.length - 2 && x > knots[i + 1]) i++
  return [i, (x - knots[i]) / (knots[i + 1] - knots[i])]
}

const FILM_CHARACTER = [-1, -0.5, 0, 0.5, 1]
const FILM_WARMTH = [-1, 0, 1]
const FILM_NEUTRAL = 2 * FILM_WARMTH.length + 1
const PRO_KNOTS = [-1, -0.5, 0, 0.5, 1]

function filmPost(stages: PostStage[], character: number, warmth: number): PostStage {
  const [i, fi] = knotPos(character, FILM_CHARACTER)
  const [j, fj] = knotPos(warmth, FILM_WARMTH)
  const at = (a: number, b: number) => stages[a * FILM_WARMTH.length + b]
  return mixPost(mixPost(at(i, j), at(i, j + 1), fj), mixPost(at(i + 1, j), at(i + 1, j + 1), fj), fi)
}

/** Pro grid nodes stored after the 12 single-slider stages: every -1/0/1 combination of two or three sliders. */
export const PRO_NODES: [number, number, number][] = [-1, 0, 1].flatMap((c) =>
  [-1, 0, 1].flatMap((k) => [-1, 0, 1].map((t) => [c, k, t] as [number, number, number])),
).filter((n) => n.filter((v) => v !== 0).length >= 2)

/**
 * After the grid nodes, a Pro table may store its captured state at zero, fitted on top of the look (for a look whose
 * sliders come from a Pro twin, the twin's state at zero). Between captured states the blend runs around it: the
 * look itself differs from it (by the look's own fit, or by being another preset), and the blend's weight on the
 * zero term reaches -1.375 at (0.5, 0.5, 0.5).
 */
export const PRO_ZERO = 12 + PRO_NODES.length

/**
 * A dense Pro table has a captured state at every point of the 5-step grid (-1, -0.5, 0, 0.5, 1 on each slider), state
 * (i, j, l) at ((i * 5) + j) * 5 + l, and blends trilinearly between them: where the states do not follow
 * the rule (CN6), the finer grid follows the states. The center is the look itself.
 */
export const PRO_DENSE = PRO_KNOTS.length ** 3
const PRO_CENTER = (PRO_DENSE - 1) / 2

/** Today's rule on the -1/0/1 grid: singles on their own axis, captured combinations, the state at zero. */
function ruleWeights(stages: PostStage[], dims: [number, number, number]): Map<number, number> {
  const c = new Map<number, number>([[-1, 1]])
  const add = (k: number, w: number) => c.set(k, (c.get(k) ?? 0) + w)
  // Stages per slider: -1, -0.5, 0.5, 1; the identity sits at 0.
  const single = (d: number, n: number) => d * 4 + (n < 0 ? 0 : 3)
  dims.forEach((v, d) => {
    if (!v) return
    const axis = [d * 4, d * 4 + 1, -1, d * 4 + 2, d * 4 + 3]
    const [i, f] = knotPos(v, PRO_KNOTS)
    add(axis[i], 1 - f)
    add(axis[i + 1], f)
    add(-1, -1)
  })
  if (stages.length > 12) {
    const hat = (v: number, n: number) => (n === 0 ? 1 - Math.abs(v) : n * v > 0 ? Math.abs(v) : 0)
    PRO_NODES.forEach((node, j) => {
      const w = node.reduce((acc, n, d) => acc * hat(dims[d], n), 1)
      if (!w) return
      add(12 + j, w)
      add(-1, -w)
      node.forEach((n, d) => {
        if (!n) return
        add(single(d, n), -w)
        add(-1, w)
      })
    })
  }
  if (stages[PRO_ZERO]) {
    // The look itself keeps its weight only near zero: the product of each slider's distance to its first captured
    // state (1 at zero, 0 at every captured state, so those stay exact); the rest of the zero term is the state's.
    const g = dims.reduce((acc, v) => acc * Math.max(0, 1 - 2 * Math.abs(v)), 1)
    add(PRO_ZERO, c.get(-1)! - g)
    c.set(-1, g)
  }
  return c
}

/** A dense table: the 8 corners of the cell around the setting on the 5-step grid, trilinearly; the center is the look. */
function denseWeights(dims: [number, number, number]): Map<number, number> {
  const c = new Map<number, number>()
  const pos = dims.map((v) => knotPos(v, PRO_KNOTS))
  for (let corner = 0; corner < 8; corner++) {
    let w = 1
    let k = 0
    for (let d = 0; d < 3; d++) {
      const up = (corner >> (2 - d)) & 1
      const [i, f] = pos[d]
      w *= up ? f : 1 - f
      k = k * PRO_KNOTS.length + i + up
    }
    if (!w) continue
    const key = k === PRO_CENTER ? -1 : k
    c.set(key, (c.get(key) ?? 0) + w)
  }
  return c
}

/**
 * A Pro setting as an affine blend of captured states. Each slider is interpolated on its own axis (identity at 0)
 * and the effects add; a look's states depend on all three sliders at once, so moving several is not the
 * sum of moving each, and each captured combination adds what the singles miss there, weighted trilinearly
 * (along a single axis the term vanishes). States blend by what they produce; the
 * states' parameters do not blend like that, so the bake runs the look once per state and blends the results.
 */
export function proTerms(stages: PostStage[], dims: [number, number, number]): { terms: PostTerm[]; lattice?: number[] } {
  // Weight per state: its index in `stages`, or -1 for the look as it is.
  const c = stages.length === PRO_DENSE ? denseWeights(dims) : ruleWeights(stages, dims)
  const used = [...c].filter(([, w]) => Math.abs(w) > 1e-9)
  // The identity has no lattice; a missing one counts as zeros.
  const n = used.reduce((m, [k]) => Math.max(m, k >= 0 ? (stages[k].lattice?.length ?? 0) : 0), 0)
  const lattice = n ? Array.from({ length: n }, () => 0) : undefined
  if (lattice) for (const [k, w] of used) if (k >= 0) stages[k].lattice?.forEach((y, i) => (lattice[i] += w * y))
  // States in lattice mode (the plain look plus a lattice) draw exactly what the look draws: one term for all.
  let plain = 0
  const terms: PostTerm[] = []
  for (const [k, w] of used) {
    if (k < 0 || isIdentityPost(stages[k])) plain += w
    else terms.push({ w, stage: { ...stages[k], lattice: undefined } })
  }
  if (Math.abs(plain) > 1e-9) terms.unshift({ w: plain, stage: null })
  return { terms, lattice }
}

const IDENTITY_CURVES = identityPost().curves

/** A post stage that changes nothing (as decoded: exact zeros and identity knots). */
export function isIdentityPost(s: PostStage): boolean {
  return (
    s.curves.every((y, i) => y === IDENTITY_CURVES[i]) &&
    s.sat.every((v) => v === 0) &&
    s.grid.every((v) => v === 0) &&
    !s.gridIn?.some((v) => v !== 0) &&
    !s.filter
  )
}

export const NEUTRAL_CAL: Calibration = { redHue: 0, redSat: 0, greenHue: 0, greenSat: 0, blueHue: 0, blueSat: 0 }

export const NEUTRAL_LOOK: LookParams = {
  temperature: 0,
  tint: 0,
  exposure: 0,
  calibration: NEUTRAL_CAL,
  tone: NEUTRAL_TONE,
  mono: 0,
  monoMix: [0.2126, 0.7152, 0.0722],
  hsl: {},
  sat: 1,
  satShadows: 1,
  satHighlights: 1,
  split: { shadowHue: 220, shadowSat: 0, highlightHue: 45, highlightSat: 0, balance: 0 },
  skin: { hue: 0, sat: 0 },
  scan: [1, 1, 1],
  grain: 0,
  grainSize: 0,
  halation: 0,
  density: 0,
  hueShadows: 0,
  hueHighlights: 0,
  chromaKnee: 0,
  postMatrix: [0, 0, 0, 0, 0, 0],
  bwMix: [0, 0, 0, 0, 0, 0, 0, 0],
}

export type LookDef = Partial<Omit<LookParams, 'tone' | 'calibration' | 'split' | 'skin'>> & {
  tone?: Partial<ToneParams>
  calibration?: Partial<Calibration>
  split?: Partial<SplitTone>
  skin?: Partial<LookParams['skin']>
}

export function resolveLook(def: LookDef): LookParams {
  return {
    ...NEUTRAL_LOOK,
    ...def,
    tone: { ...NEUTRAL_TONE, ...def.tone },
    calibration: { ...NEUTRAL_CAL, ...def.calibration },
    split: { ...NEUTRAL_LOOK.split, ...def.split },
    skin: { ...NEUTRAL_LOOK.skin, ...def.skin },
    hsl: def.hsl ?? {},
  }
}

const LUMA: Vec3 = [0.2126, 0.7152, 0.0722]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Calibration primaries -> 3x3 linear matrix that keeps neutrals neutral. */
export function calibrationMatrix(c: Calibration): Mat3 {
  const prim = (p: Vec3, towardPos: Vec3, towardNeg: Vec3, hue: number, sat: number): Vec3 => {
    const t = hue >= 0 ? towardPos : towardNeg
    const k = Math.abs(hue) * 0.35
    let v: Vec3 = [p[0] + t[0] * k, p[1] + t[1] * k, p[2] + t[2] * k]
    const y = dot(v, LUMA)
    const s = 1 + sat * 0.6
    v = [y + (v[0] - y) * s, y + (v[1] - y) * s, y + (v[2] - y) * s]
    // Preserve the primary's luminance so calibration does not relight.
    const k2 = dot(p, LUMA) / Math.max(1e-4, dot(v, LUMA))
    return [v[0] * k2, v[1] * k2, v[2] * k2]
  }
  const r = prim([1, 0, 0], [0, 1, 0], [0, 0, 1], c.redHue, c.redSat)
  const g = prim([0, 1, 0], [0, 0, 1], [1, 0, 0], c.greenHue, c.greenSat)
  const b = prim([0, 0, 1], [1, 0, 0], [0, 1, 0], c.blueHue, c.blueSat)
  // Columns are the new primaries.
  const m: Mat3 = [r[0], g[0], b[0], r[1], g[1], b[1], r[2], g[2], b[2]]
  // Normalize rows so (1,1,1) -> (1,1,1).
  for (let i = 0; i < 3; i++) {
    const s = m[i * 3] + m[i * 3 + 1] + m[i * 3 + 2]
    for (let j = 0; j < 3; j++) m[i * 3 + j] /= s
  }
  return m
}

export function lookInputMatrix(p: LookParams): Mat3 {
  const wb = whiteBalanceMatrix(p.temperature, p.tint)
  return mul(calibrationMatrix(p.calibration), wb)
}

export type DimKind = 'pro' | 'film' | 'none'
export const DIMS_FOR: Record<DimKind, DimId[]> = {
  pro: ['contrast', 'color', 'tone'],
  film: ['character', 'warmth'],
  none: [],
}


/** Move a look through its dims. Dims are -1..1 (display -6..6). */
export function applyDims(p: LookParams, dims: Record<DimId, number>): LookParams {
  // The slider table is large and only read here; keep it out of the clone and the result.
  const { sliders, ...rest } = p
  const out: LookParams = structuredClone(rest)
  const { contrast, color, tone, character, warmth } = dims
  if (sliders?.kind === 'film') {
    // The neutral state (Character 0, Warmth 0) can carry a correction lattice of its own; it applies at zero too.
    if (character || warmth || sliders.stages[FILM_NEUTRAL].lattice) out.post = filmPost(sliders.stages, character, warmth)
    return applyParametricDims(out, { contrast, color, tone, character: 0, warmth: 0 })
  }
  if (sliders?.kind === 'pro') {
    if (contrast || color || tone) {
      const { terms, lattice } = proTerms(sliders.stages, [contrast, color, tone])
      out.postTerms = terms
      if (lattice) out.postLattice = lattice
    }
    return applyParametricDims(out, { contrast: 0, color: 0, tone: 0, character, warmth })
  }
  return applyParametricDims(out, dims)
}

/**
 * Hand-built Contrast, Color and Tone as a post stage on the look's output, for looks with a correction
 * lattice. The lattice was fitted to the look's unmoved output and is indexed by the input color, so moving
 * the parameters under it leaves its offsets pushing the old colors: a muted Color turned the output's hues
 * by 25 degrees on the median lattice look, and some got more colorful instead of less. On the output the
 * same slider values scale chroma around the look's own hues and bend its tones.
 */
export function outputDims(contrast: number, color: number, tone: number): PostStage {
  const curve = Array.from({ length: POST_KNOTS }, (_, i) => {
    const v = i / (POST_KNOTS - 1)
    const y = sCurve(v, Math.max(-1, Math.min(1, contrast * 0.3)), 0.5)
    // Tone moves the output's black up (-) or its white down (+), as the parametric dims do.
    if (tone < 0) return -tone * 0.13 + (1 + tone * 0.13) * y
    return y * (1 - Math.max(0, tone) * 0.12)
  })
  const k = Math.max(0.05, 1 + color * (color > 0 ? 0.38 : 0.55))
  return { curves: [...curve, ...curve, ...curve], sat: [Math.log(k), 0, 0], grid: Array.from({ length: POST_CELLS * 3 }, () => 0) }
}

/** Hand-built dims for looks without a captured slider table. Mutates and returns `out`. */
function applyParametricDims(out: LookParams, dims: Record<DimId, number>): LookParams {
  const { character, warmth } = dims
  let { contrast, color, tone } = dims

  if (out.lattice && !out.post && (contrast || color || tone)) {
    out.post = outputDims(contrast, color, tone)
    out.postAfter = true
    contrast = color = tone = 0
  }
  if (contrast) out.tone.contrast = Math.max(-1, Math.min(1, out.tone.contrast + contrast * 0.3))
  if (color) {
    // Vibrant to muted: chroma and the look's own selective moves scale together.
    // The vibrant side is gentler: fitted grids already push saturated colors.
    const k = Math.max(0, 1 + color * (color > 0 ? 0.38 : 0.55))
    out.density *= Math.max(0, 1 + color * 0.4)
    out.sat *= k
    out.split.shadowSat *= k
    out.split.highlightSat *= k
    for (const band of HSL_BANDS) {
      const v = out.hsl[band]
      if (v) out.hsl[band] = { ...v, h: (v.h ?? 0) * (1 + color * 0.3), s: (v.s ?? 0) * k }
    }
  }
  if (tone) {
    // Fade from highlights (+) to shadows (-).
    if (tone < 0) out.tone.black = out.tone.black.map((x) => x - tone * 0.13) as Vec3
    else out.tone.white = out.tone.white.map((x) => x - tone * 0.12) as Vec3
  }
  if (character) {
    // Push or pull the "negative": more exposure into the stock gives denser,
    // richer color and contrast after scanning; less gives a thin, flat,
    // cast-heavy scan. Brightness is re-normalized like a lab scanner would.
    const c = character
    out.exposure += c * 0.45
    out.tone.gamma = out.tone.gamma.map((g) => g * Math.pow(2, c * 0.28)) as Vec3
    out.tone.contrast = Math.max(-1, Math.min(1, out.tone.contrast + c * 0.18))
    out.sat *= 1 + c * 0.22
    out.density *= Math.max(0, 1 + c * 0.3)
    // Underexposed negatives scan grainier.
    out.grain = Math.max(0, out.grain * (1 - c * 0.35))
    if (c < 0) {
      const lift = -c * 0.06
      const tint = out.tone.black
      const m = Math.max(1e-3, Math.max(...tint))
      out.tone.black = tint.map((x) => x + lift * (0.6 + 0.4 * (x / m))) as Vec3
      out.split.shadowSat *= 1 - c * 0.6
    }
  }
  if (warmth) {
    // Scanner balance on a blue/amber axis, after the film curve.
    const w = warmth * 0.12
    out.scan = [out.scan[0] * (1 + w), out.scan[1] * (1 + w * 0.25), out.scan[2] * (1 - w)]
  }
  return out
}

/** Row-major 3x3 from the 6 crosstalk terms; each row sums to 1 so neutrals stay neutral. */
export function postMatrix3(p: LookParams['postMatrix']): Mat3 {
  const m: Mat3 = [0, p[0], p[1], p[2], 0, p[3], p[4], p[5], 0]
  m[0] = 1 - p[0] - p[1]
  m[4] = 1 - p[2] - p[3]
  m[8] = 1 - p[4] - p[5]
  return m
}

export { apply }
