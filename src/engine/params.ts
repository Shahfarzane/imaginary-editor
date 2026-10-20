import { buildToneCurves, LOOK_CURVE_SIZE, monotoneSpline, whiteBalanceMatrix, type Mat3, type Vec3 } from './color'
import { applyDims, GRID_CELLS, latticeN, lookInputMatrix, MAX_POST_TERMS, POST_CELLS, POST_KNOTS, postMatrix3, resampleLattice, type LookParams, type PostStage } from './look'
import { HSL_BANDS, isCurveIdentity, type Edit } from '../model/edit'
import { STAGED_TOOLS, stageAt, TOOL_KNOTS, type ToolStage } from './tools'
import { toolTables } from '../model/toolData'
import type { UniformValue } from './gl'

// Rows: 0-2 look tone R,G,B; 3-6 user master,R,G,B; 7-9 look post stage R,G,B;
// 10-30 tool stages (3 per staged tool, in STAGED_TOOLS order); 31 Saturation's HSL curve;
// from 32, three per Pro term (R, G, B of its post stage).
export const TERM_CURVE_ROW = 32
export const CURVE_ROWS = TERM_CURVE_ROW + 3 * MAX_POST_TERMS
export const TOOL_GRID_ROWS = STAGED_TOOLS.length * 2 * 7
export const GLOW_LEVELS = 6

export interface RenderSpec {
  lutKey: string
  bake: Record<string, UniformValue>
  curves: Float32Array
  /** Color grid texels (RGBA32F, GRID_HUES * GRID_C wide, GRID_L tall) or null. */
  grid: Float32Array | null
  /** Input color grid texels, same layout. */
  gridIn: Float32Array | null
  /** Post stage grid texels (POST_HUES * POST_C wide, POST_L tall per stage: the post stage, or each Pro term's) or null. */
  postGrid: Float32Array | null
  /** Post stage input grid texels (same layout) or null. */
  postGridIn: Float32Array | null
  /** Pro terms, MAX_POST_TERMS wide and 3 tall: (weight, saturation), B&W filter, (input grid on, identity, -1, 0); or null. */
  terms: Float32Array | null
  /** Per term, what its look depends on (the look, the tools ahead of it, the state): its key in the renderer's cache. */
  termKeys: string[] | null
  /** Tool stage grids: per staged tool 7 rows of output grid then 7 of input grid (GRID layout), or null. */
  toolGrids: Float32Array | null
  /** Correction lattice texels (RGBA32F, n^2 wide, n tall, n = latticeN): the look's plus its slider state's, or null. */
  lattice: Float32Array | null
  latticeN: number
  /** The look's strength base lattice, same layout (n = baseN), or null: Strength mixes with the photo. */
  baseLattice: Float32Array | null
  baseN: number
  develop: Record<string, UniformValue>
  local: { on: boolean; base: boolean; mid: boolean; fine: boolean }
  glow: { on: boolean; halThreshold: number; bloomThreshold: number; weights: [number, number, number, number][]; exposure: number }
  aberration: number
  /**
   * The edit changes no colors: no look, every color tool and effect at zero, so the bake writes the identity table
   * and the develop pass adds nothing. Such a render gets no dither and returns the source's own values.
   */
  neutral: boolean
}

export type LookResolver = (id: string) => LookParams | null

const splitAB = (hue: number, sat: number): [number, number] => {
  const r = (hue * Math.PI) / 180
  return [Math.cos(r) * sat * 0.07, Math.sin(r) * sat * 0.07]
}

function gaussianWeights(center: number, sigma: number) {
  const w = Array.from({ length: GLOW_LEVELS }, (_, i) => Math.exp(-((i - center) ** 2) / (2 * sigma * sigma)))
  const s = w.reduce((a, b) => a + b, 0)
  return w.map((x) => x / s)
}

/** Cell (l, h, c) lands at texel (h * GRID_C.length + c, l); the layouts match, so this only pads to RGBA. */
function gridTexels(grid: number[], cells = GRID_CELLS): Float32Array {
  const out = new Float32Array(cells * 4)
  for (let i = 0; i < cells; i++) {
    out[i * 4] = grid[i * 3]
    out[i * 4 + 1] = grid[i * 3 + 1]
    out[i * 4 + 2] = grid[i * 3 + 2]
  }
  return out
}

/** The look's correction lattice plus its slider state's, on the finer of the two node grids. */
function combinedLattice(look: LookParams | null): number[] | null {
  const a = look?.lattice
  const b = look?.post?.lattice ?? look?.postLattice
  if (!a && !b) return null
  if (!a || !b) return (a ?? b)!
  // On the finer of the two grids: a film state's lattice can be finer than its look's.
  const n = Math.max(latticeN(a), latticeN(b))
  const aa = resampleLattice(a, n)
  const bb = resampleLattice(b, n)
  return aa.map((v, i) => v + bb[i])
}

/** A stage's premultiplied B&W filter as (amount, R, G, B weights) for the shader. */
function postFilter(f: [number, number, number, number] | undefined): [number, number, number, number] {
  if (!f || f[0] < 1e-4) return [0, 0, 0, 0]
  return [Math.min(1, f[0]), f[1] / f[0], f[2] / f[0], f[3] / f[0]]
}

/** A Pro term's look depends on the look itself (not its lattice, slider terms or post stage), the tools ahead of it, and its own state. */
function termKeys(look: LookParams, stages: (PostStage | null)[], pre: unknown[]): string[] {
  const core = JSON.stringify([pre, { ...look, postTerms: undefined, postLattice: undefined, lattice: undefined, post: undefined, postAfter: undefined }])
  return stages.map((s) => core + (s ? JSON.stringify(s) : 'look'))
}

export function buildRenderSpec(edit: Edit, resolve: LookResolver): RenderSpec {
  const t = edit.tools
  const fx = edit.fx

  // ---- look ----
  const baseLook = edit.preset.custom ?? (edit.preset.id ? resolve(edit.preset.id) : null)
  const look = baseLook ? applyDims(baseLook, edit.preset.dims) : null

  const curves = new Float32Array(LOOK_CURVE_SIZE * CURVE_ROWS)
  if (look) curves.set(buildToneCurves(look.tone, look.curve, look.channelCurves), 0)
  // Post stage curves are linear between knots, sampled over 0..1.
  const postCurves = (stage: PostStage, row: number) => {
    for (let c = 0; c < 3; c++)
      for (let i = 0; i < LOOK_CURVE_SIZE; i++) {
        const u = (i / (LOOK_CURVE_SIZE - 1)) * (POST_KNOTS - 1)
        const k = Math.min(POST_KNOTS - 2, Math.floor(u))
        const a = stage.curves[c * POST_KNOTS + k]
        const b = stage.curves[c * POST_KNOTS + k + 1]
        curves[(row + c) * LOOK_CURVE_SIZE + i] = a + (b - a) * (u - k)
      }
  }
  const post = look?.post
  if (post) postCurves(post, 7)
  const terms = look?.postTerms ?? null
  terms?.forEach((t, k) => t.stage && postCurves(t.stage, TERM_CURVE_ROW + 3 * k))
  // Post grids, one block per stage: the post stage's in block 0, or each term's in its own.
  const postStages = terms ? terms.map((t) => t.stage) : post ? [post] : []
  const postBlocks = (pick: (s: PostStage) => number[] | undefined) => {
    if (!postStages.some((s) => s && pick(s))) return null
    const out = new Float32Array(POST_CELLS * 4 * MAX_POST_TERMS)
    postStages.forEach((s, k) => {
      const g = s && pick(s)
      if (g) out.set(gridTexels(g, POST_CELLS), k * POST_CELLS * 4)
    })
    return out
  }
  let termTexels: Float32Array | null = null
  if (terms) {
    termTexels = new Float32Array(MAX_POST_TERMS * 3 * 4)
    terms.forEach((t, k) => {
      termTexels!.set([t.w, ...(t.stage?.sat ?? [0, 0, 0])], k * 4)
      termTexels!.set(postFilter(t.stage?.filter), (MAX_POST_TERMS + k) * 4)
      termTexels!.set([t.stage?.gridIn ? 1 : 0, t.stage ? 0 : 1, -1, 0], (2 * MAX_POST_TERMS + k) * 4)
    })
  }
  const userCurvesOn = !(['rgb', 'r', 'g', 'b'] as const).every((c) => isCurveIdentity(edit.curves[c]))
  ;(['rgb', 'r', 'g', 'b'] as const).forEach((c, i) => {
    curves.set(monotoneSpline(edit.curves[c], LOOK_CURVE_SIZE), (3 + i) * LOOK_CURVE_SIZE)
  })

  // ---- tool stages ----
  const tables = toolTables()
  const stages = STAGED_TOOLS.map((id) => (tables ? stageAt(tables[id], t[id]) : null))
  const staged = stages.some(Boolean)
  const sampleKnots = (ys: number[], row: number) => {
    // Monotone spline through evenly spaced knots, like the fitted curves.
    curves.set(monotoneSpline(ys.map((y, i) => [i / (ys.length - 1), y] as [number, number]), LOOK_CURVE_SIZE), row * LOOK_CURVE_SIZE)
  }
  stages.forEach((st, i) => st && st.curves.forEach((ys, c) => sampleKnots(ys, 10 + i * 3 + c)))
  const sat: ToolStage | null = stages[STAGED_TOOLS.indexOf('saturation')]
  if (sat?.hsl) {
    // Linear between knots, as fitted.
    for (let i = 0; i < LOOK_CURVE_SIZE; i++) {
      const u = (i / (LOOK_CURVE_SIZE - 1)) * (TOOL_KNOTS - 1)
      const k = Math.min(TOOL_KNOTS - 2, Math.floor(u))
      curves[31 * LOOK_CURVE_SIZE + i] = sat.hsl[k] + (sat.hsl[k + 1] - sat.hsl[k]) * (u - k)
    }
  }
  let toolGrids: Float32Array | null = null
  if (staged) {
    toolGrids = new Float32Array(GRID_CELLS * 4 * STAGED_TOOLS.length * 2)
    stages.forEach((st, i) => {
      if (!st) return
      toolGrids!.set(gridTexels(st.grid), (i * 2) * GRID_CELLS * 4)
      if (st.gridIn) toolGrids!.set(gridTexels(st.gridIn), (i * 2 + 1) * GRID_CELLS * 4)
    })
  }

  const lk = look ?? null
  const lattice = combinedLattice(lk)
  const base = lk?.strengthBase ?? null
  const hslArr = (src: Partial<Record<string, { h?: number; s?: number; l?: number }>>, k: 'h' | 's' | 'l') =>
    HSL_BANDS.map((b) => src[b]?.[k] ?? 0)

  const bake: Record<string, UniformValue> = {
    // With tool stages loaded, these tools run as stages and the formulas below go neutral.
    uWB: tables ? whiteBalanceMatrix(0, 0) : whiteBalanceMatrix(t.temperature, t.tint),
    uExposure: tables ? 0 : t.exposure * 2,
    uToolsStaged: staged ? 1 : 0,
    'uToolOn[]': stages.map((st) => (st ? 1 : 0)),
    'uToolInOn[]': stages.map((st) => (st?.gridIn ? 1 : 0)),
    uToolHslOn: sat?.hsl ? 1 : 0,
    uLookOn: lk ? 1 : 0,
    uStrength: edit.preset.strength,
    uLkMatrix: lk ? lookInputMatrix(lk) : [1, 0, 0, 0, 1, 0, 0, 0, 1],
    uLkExposure: lk?.exposure ?? 0,
    uLkMono: lk?.mono ?? 0,
    uLkMonoMix: (lk?.monoMix ?? [0.2126, 0.7152, 0.0722]) as Vec3,
    'uLkHslH[]': hslArr(lk?.hsl ?? {}, 'h'),
    'uLkHslS[]': hslArr(lk?.hsl ?? {}, 's'),
    'uLkHslL[]': hslArr(lk?.hsl ?? {}, 'l'),
    uLkSat: [lk?.sat ?? 1, lk?.satShadows ?? 1, lk?.satHighlights ?? 1],
    uLkSplit: lk
      ? [...splitAB(lk.split.shadowHue, lk.split.shadowSat), ...splitAB(lk.split.highlightHue, lk.split.highlightSat)]
      : [0, 0, 0, 0],
    uLkSplitBalance: lk?.split.balance ?? 0,
    uLkSkin: [lk?.skin.hue ?? 0, lk?.skin.sat ?? 0],
    uLkScan: (lk?.scan ?? [1, 1, 1]) as Vec3,
    uLkPost: postMatrix3(lk?.postMatrix ?? [0, 0, 0, 0, 0, 0]),
    uLkDensity: lk?.density ?? 0,
    uLkHueShadows: lk?.hueShadows ?? 0,
    uLkHueHighlights: lk?.hueHighlights ?? 0,
    uLkChromaKnee: lk?.chromaKnee ?? 0,
    'uLkBw[]': lk?.bwMix ?? [0, 0, 0, 0, 0, 0, 0, 0],
    uLkBwOn: lk?.bwMix?.some((v) => v !== 0) ? 1 : 0,
    uLkGridOn: lk?.grid ? 1 : 0,
    uLkGridInOn: lk?.gridIn ? 1 : 0,
    uLkGridScale: (lk?.gridScale ?? [1, 1, 1]) as Vec3,
    uLkRgbOn: lk?.rgbMatrix ? 1 : 0,
    uLkRgb: (lk?.rgbMatrix?.slice(0, 9) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1]) as Mat3,
    uLkRgbOffset: (lk?.rgbMatrix?.slice(9, 12) ?? [0, 0, 0]) as Vec3,
    uLkPostOn: post ? 1 : 0,
    uLkPostAfter: look?.postAfter ? 1 : 0,
    uLkPostSat: (post?.sat ?? [0, 0, 0]) as Vec3,
    uLkPostInOn: post?.gridIn ? 1 : 0,
    uLkPostFilter: postFilter(post?.filter),
    uLkTermCount: { int: terms?.length ?? 0 },
    uLkLatticeOn: lattice ? 1 : 0,
    uLkLatticeN: { int: lattice ? latticeN(lattice) : 2 },
    uLkBaseOn: base ? 1 : 0,
    uLkBaseN: { int: base ? latticeN(base) : 2 },

    'uHslH[]': hslArr(edit.hsl, 'h'),
    'uHslS[]': hslArr(edit.hsl, 's'),
    'uHslL[]': hslArr(edit.hsl, 'l'),
    uSaturation: tables ? 0 : t.saturation,
    uVibrance: t.vibrance,
    uDensity: t.density ?? 0,
    uBwOn: edit.bw?.on ? 1 : 0,
    'uBw[]': edit.bw?.mix ?? [0, 0, 0, 0, 0, 0, 0, 0],
    uSkinTone: tables ? 0 : t.skinTone,
    uSplit: [
      ...splitAB(edit.split.shadowHue, edit.split.shadowSat),
      ...splitAB(edit.split.highlightHue, edit.split.highlightSat),
    ],
    uSplitBalance: edit.split.balance,
    uContrast: tables ? 0 : t.contrast,
    uWhites: t.whites,
    uBlacks: t.blacks,
    uFade: tables ? 0 : t.fade,
    uCurvesOn: userCurvesOn ? 1 : 0,
  }

  const lutKey = JSON.stringify([
    tables ? 'staged' : 'formula',
    // A custom look is covered by the resolved look below; skip its second copy.
    { ...edit.preset, custom: undefined },
    t.temperature,
    t.tint,
    t.exposure,
    t.saturation,
    t.vibrance,
    t.density,
    t.skinTone,
    t.contrast,
    t.whites,
    t.blacks,
    t.fade,
    edit.hsl,
    edit.split,
    edit.curves,
    edit.bw,
    // Look definitions can change at runtime (Look Mixer, Match Look).
    look ? JSON.stringify(look) : null,
  ])

  const local = {
    base: t.highlights !== 0 || t.shadows !== 0,
    mid: t.clarity !== 0,
    fine: t.texture !== 0,
    on: false,
  }
  local.on = local.base || local.mid || local.fine

  const halation = Math.min(1, fx.halation + (lk ? lk.halation * edit.preset.strength : 0))
  const halW = gaussianWeights(1.1 + fx.halationSpread * 1.0, 0.8)
  const bloomW = gaussianWeights(2.6 + fx.bloomSpread * 1.3, 1.1)
  const weights = halW.map((h, i) => [bloomW[i], bloomW[i], bloomW[i], h] as [number, number, number, number])

  // RAW Exposure in stops (3 at the end of the slider); an edit saved before it existed has none.
  const rawExposure = (t.rawExposure ?? 0) * 3
  const neutral =
    !lk &&
    !staged &&
    !userCurvesOn &&
    !edit.bw?.on &&
    edit.split.shadowSat === 0 &&
    edit.split.highlightSat === 0 &&
    HSL_BANDS.every((b) => !edit.hsl[b]?.h && !edit.hsl[b]?.s && !edit.hsl[b]?.l) &&
    [t.temperature, t.tint, t.exposure, t.saturation, t.vibrance, t.density, t.skinTone, t.contrast, t.whites, t.blacks, t.fade].every((v) => !v) &&
    !local.on &&
    !t.sharpen &&
    !rawExposure &&
    halation === 0 &&
    [fx.bloom, fx.leak, fx.vignette, fx.grain, fx.dust, fx.aberration].every((v) => !v)
  const develop: Record<string, UniformValue> = {
    uRawExposure: rawExposure,
    uHighlights: t.highlights,
    uShadows: t.shadows,
    uClarity: t.clarity,
    uTexture: t.texture,
    uSharpen: t.sharpen,
    uLocalOn: local.on ? 1 : 0,
    uHalation: halation,
    uHalationSpread: fx.halationSpread,
    uBloom: fx.bloom,
    uGlowOn: halation > 0 || fx.bloom > 0 ? 1 : 0,
    uVignette: fx.vignette,
    uVignetteFeather: fx.vignetteFeather,
    uLeak: fx.leak,
    uLeakWarmth: fx.leakWarmth,
    uGrain: Math.min(1, fx.grain + (lk ? lk.grain * edit.preset.strength : 0)),
    uGrainSize: fx.grain > 0 || !lk ? fx.grainSize : lk.grainSize,
    uGrainRough: Math.max(0, fx.grainRough),
    uGrainColor: fx.grainColor,
    uDust: fx.dust,
    uSeed: edit.seed % 10007,
  }

  return {
    lutKey,
    bake,
    curves,
    grid: lk?.grid ? gridTexels(lk.grid) : null,
    gridIn: lk?.gridIn ? gridTexels(lk.gridIn) : null,
    postGrid: postBlocks((s) => s.grid),
    postGridIn: postBlocks((s) => s.gridIn),
    terms: termTexels,
    termKeys: terms ? termKeys(look!, terms.map((t) => t.stage), [staged, tables ? 1 : 0, t.exposure, t.temperature, t.tint]) : null,
    toolGrids,
    // Node (r, g, b) sits at texel (r + N * g, b): the nodes' own order, so this only pads to RGBA.
    lattice: lattice ? gridTexels(lattice, lattice.length / 3) : null,
    latticeN: lattice ? latticeN(lattice) : 0,
    baseLattice: base ? gridTexels(base, base.length / 3) : null,
    baseN: base ? latticeN(base) : 0,
    develop,
    local,
    glow: { on: halation > 0 || fx.bloom > 0, halThreshold: 0.62, bloomThreshold: 0.45, weights, exposure: rawExposure },
    aberration: fx.aberration,
    neutral,
  }
}
