// The edit document for one photo. Slider values are stored normalized:
// bipolar tools in -1..1, unipolar in 0..1. The UI shows them as -6..6 / 0..12
// so one display step is 1/120 of the range.

export type ToolId =
  | 'exposure'
  | 'rawExposure'
  | 'contrast'
  | 'highlights'
  | 'shadows'
  | 'whites'
  | 'blacks'
  | 'fade'
  | 'clarity'
  | 'texture'
  | 'sharpen'
  | 'temperature'
  | 'tint'
  | 'saturation'
  | 'vibrance'
  | 'skinTone'
  | 'density'

export type FxId =
  | 'grain'
  | 'grainSize'
  | 'grainColor'
  | 'grainRough'
  | 'halation'
  | 'halationSpread'
  | 'bloom'
  | 'bloomSpread'
  | 'vignette'
  | 'vignetteFeather'
  | 'aberration'
  | 'leak'
  | 'leakWarmth'
  | 'dust'

export type DimId = 'contrast' | 'color' | 'tone' | 'character' | 'warmth'

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const
export type HslBand = (typeof HSL_BANDS)[number]
export type HslValue = { h: number; s: number; l: number }

export type CurvePoint = [number, number]
export type CurveChannel = 'rgb' | 'r' | 'g' | 'b'

export type BorderKind = 'none' | 'solid' | 'film35' | 'instant' | 'medium'

export interface SplitTone {
  shadowHue: number // degrees
  shadowSat: number // 0..1
  highlightHue: number
  highlightSat: number
  balance: number // -1..1
}

export interface Crop {
  // Normalized rect inside the straightened, rotated image.
  x: number
  y: number
  w: number
  h: number
  aspect: string // 'free' | 'original' | 'w:h'
  rot90: 0 | 1 | 2 | 3
  straighten: number // degrees, -15..15
  flipH: boolean
  flipV: boolean
}

export interface Border {
  kind: BorderKind
  size: number // 0..1
  color: string
}

export interface Edit {
  preset: {
    id: string | null
    strength: number
    dims: Record<DimId, number>
    /** A look computed at edit time by the retired Mixer, Match Look and Surprise; edits saved with one still render it. Wins over id. */
    custom?: import('../engine/look').LookParams
    label?: string
    /** Code of the strip tile this look was picked from; a look can show as more than one tile (its Pro version). */
    tile?: string
  }
  tools: Record<ToolId, number>
  fx: Record<FxId, number>
  hsl: Record<HslBand, HslValue>
  split: SplitTone
  curves: Record<CurveChannel, CurvePoint[]>
  crop: Crop
  border: Border
  /** Black & white conversion with a per-hue lightness mixer (-1..1 per band). */
  bw: { on: boolean; mix: number[] }
  seed: number
}

export interface SliderDef<Id extends string = string> {
  id: Id
  label: string
  bipolar: boolean
  /** Display scale: value 1 shows as this number. */
  scale: number
  /** Track gradient [start, mid, end] when the track is colored. */
  gradient?: [string, string, string]
  default?: number
}

const b = <Id extends string>(id: Id, label: string, extra: Partial<SliderDef<Id>> = {}): SliderDef<Id> => ({
  id,
  label,
  bipolar: true,
  scale: 6,
  ...extra,
})
const u = <Id extends string>(id: Id, label: string, extra: Partial<SliderDef<Id>> = {}): SliderDef<Id> => ({
  id,
  label,
  bipolar: false,
  scale: 12,
  ...extra,
})

export const TEMP_GRADIENT: [string, string, string] = ['rgb(80,151,248)', 'rgb(205,205,205)', 'rgb(247,205,69)']
export const TINT_GRADIENT: [string, string, string] = ['rgb(68,137,83)', 'rgb(205,205,205)', 'rgb(234,89,186)']

export const TOOL_GROUPS: { title: string; tools: SliderDef<ToolId>[] }[] = [
  {
    title: 'Light',
    tools: [
      b('exposure', 'Exposure'),
      // Stops of light, ahead of the tone tools and the white clamp, so RAW light above white can come back under it
      // (Exposure acts on the picture as displayed). Shown for RAW photos.
      b('rawExposure', 'RAW Exposure', { scale: 3 }),
      b('contrast', 'Contrast'),
      b('highlights', 'Highlights'),
      b('shadows', 'Shadows'),
      b('whites', 'Whites'),
      b('blacks', 'Blacks'),
      u('fade', 'Fade'),
    ],
  },
  {
    title: 'Color',
    tools: [
      b('temperature', 'Temperature', { gradient: TEMP_GRADIENT }),
      b('tint', 'Tint', { gradient: TINT_GRADIENT }),
      b('saturation', 'Saturation'),
      b('vibrance', 'Vibrance'),
      u('density', 'Density'),
      b('skinTone', 'Skin Tone'),
    ],
  },
  {
    title: 'Detail',
    tools: [b('clarity', 'Clarity'), b('texture', 'Texture'), u('sharpen', 'Sharpen')],
  },
]

export const FX_GROUPS: { title: string; tools: SliderDef<FxId>[] }[] = [
  // Grain is the only effect in the Tools panel.
  {
    title: 'Effects',
    tools: [
      u('grain', 'Grain'),
      b('grainSize', 'Grain Size'),
      // 0..1: the shader blends in octaves above 0 and does nothing below it.
      u('grainRough', 'Grain Roughness'),
      u('grainColor', 'Grain Color'),
    ],
  },
  {
    title: 'Halation',
    tools: [u('halation', 'Halation'), b('halationSpread', 'Spread')],
  },
  {
    title: 'Bloom',
    tools: [u('bloom', 'Bloom'), b('bloomSpread', 'Spread')],
  },
  {
    title: 'Lens',
    tools: [b('vignette', 'Vignette'), b('vignetteFeather', 'Feather'), u('aberration', 'Aberration')],
  },
  {
    title: 'Light Leak',
    tools: [u('leak', 'Leak'), b('leakWarmth', 'Warmth')],
  },
  {
    title: 'Dust',
    tools: [u('dust', 'Dust')],
  },
]

export const DIM_DEFS: Record<DimId, SliderDef<DimId>> = {
  contrast: b('contrast', 'Contrast'),
  color: b('color', 'Color'),
  tone: b('tone', 'Tone'),
  character: b('character', 'Character'),
  warmth: b('warmth', 'Warmth', { gradient: TEMP_GRADIENT }),
}

export const HSL_SWATCH: Record<HslBand, string> = {
  red: '#e5484d',
  orange: '#f76b15',
  yellow: '#ffc53d',
  green: '#46a758',
  aqua: '#12a594',
  blue: '#0090ff',
  purple: '#8e4ec6',
  magenta: '#d6409f',
}

const zeroRecord = <K extends string>(keys: readonly K[], v = 0) =>
  Object.fromEntries(keys.map((k) => [k, v])) as Record<K, number>

export const TOOL_IDS = TOOL_GROUPS.flatMap((g) => g.tools.map((t) => t.id))
export const FX_IDS = FX_GROUPS.flatMap((g) => g.tools.map((t) => t.id))

export const identityCurve = (): CurvePoint[] => [
  [0, 0],
  [1, 1],
]

export function defaultEdit(seed = Math.floor(Math.random() * 1e6)): Edit {
  return {
    preset: { id: null, strength: 1, dims: { contrast: 0, color: 0, tone: 0, character: 0, warmth: 0 } },
    tools: zeroRecord(TOOL_IDS),
    fx: zeroRecord(FX_IDS),
    hsl: Object.fromEntries(HSL_BANDS.map((k) => [k, { h: 0, s: 0, l: 0 }])) as Record<HslBand, HslValue>,
    split: { shadowHue: 220, shadowSat: 0, highlightHue: 45, highlightSat: 0, balance: 0 },
    curves: { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    crop: { x: 0, y: 0, w: 1, h: 1, aspect: 'original', rot90: 0, straighten: 0, flipH: false, flipV: false },
    border: { kind: 'none', size: 0.5, color: '#ffffff' },
    bw: { on: false, mix: [0, 0, 0, 0, 0, 0, 0, 0] },
    seed,
  }
}

/** Deep-ish clone that is cheap and JSON safe. */
export const cloneEdit = (e: Edit): Edit => structuredClone(e)

/** The parts of an edit that "Copy edits" transfers (not crop, not seed). */
export function pasteEdit(target: Edit, source: Edit): Edit {
  const s = cloneEdit(source)
  return { ...s, crop: target.crop, seed: target.seed }
}

export const isCurveIdentity = (pts: CurvePoint[]) =>
  pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1

/** The original photo in its current framing: every look, tool and effect off, crop kept. */
export const originalWithCrop = (e: Edit): Edit => ({ ...defaultEdit(e.seed), crop: e.crop })

/** True when the framing differs from the photo as shot: cropped, rotated, straightened or flipped. */
export const isReframed = (c: Edit['crop']): boolean =>
  c.x !== 0 || c.y !== 0 || c.w !== 1 || c.h !== 1 || !!c.rot90 || !!c.straighten || !!c.flipH || !!c.flipV

/** Any edit at all, framing included: what the grid's edited badge shows. */
export const hasEdits = (e: Edit): boolean => !isUnedited(e) || isReframed(e.crop)

/** True when an edit changes nothing but the framing. Checks values, so older saved edits missing newer fields still count. */
export function isUnedited(e: Edit): boolean {
  return (
    !e.preset.id &&
    !e.preset.custom &&
    TOOL_IDS.every((k) => !e.tools[k]) &&
    FX_IDS.every((k) => !e.fx?.[k]) &&
    HSL_BANDS.every((k) => !e.hsl?.[k]?.h && !e.hsl?.[k]?.s && !e.hsl?.[k]?.l) &&
    !e.split?.shadowSat &&
    !e.split?.highlightSat &&
    (['rgb', 'r', 'g', 'b'] as const).every((c) => !e.curves?.[c] || isCurveIdentity(e.curves[c])) &&
    !e.bw?.on &&
    (e.border?.kind ?? 'none') === 'none'
  )
}
