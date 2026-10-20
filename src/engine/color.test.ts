import { describe, expect, it } from 'vite-plus/test'
import {
  apply,
  buildToneCurves,
  linearToOklab,
  linearToSrgb,
  LOOK_CURVE_SIZE,
  monotoneSpline,
  oklabToLinear,
  P3_TO_SRGB,
  REC2020_TO_SRGB,
  SRGB_TO_P3,
  sCurve,
  shaper,
  shaperInv,
  SHAPER_MAX,
  srgbToLinear,
  whiteBalanceMatrix,
} from './color'
import { applyDims, calibrationMatrix, resolveLook } from './look'
import { PRESETS } from '../model/presets'
import { outputToSource, fitCropInRotation } from './geometry'
import { defaultEdit } from '../model/edit'

describe('transfer functions', () => {
  it('sRGB round trips', () => {
    for (const v of [0, 0.001, 0.04, 0.2, 0.5, 0.9, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 6)
  })
  it('shaper covers 0..SHAPER_MAX and round trips', () => {
    expect(shaper(0)).toBe(0)
    expect(shaper(SHAPER_MAX)).toBeCloseTo(1, 6)
    for (const v of [0, 0.0005, 0.18, 1, 4]) expect(shaperInv(shaper(v))).toBeCloseTo(v, 5)
    // Most of the LUT lattice should be spent below 1.0 (the normal range).
    expect(shaper(1)).toBeGreaterThan(0.6)
  })
  it('oklab round trips', () => {
    const c: [number, number, number] = [0.3, 0.6, 0.1]
    const back = oklabToLinear(linearToOklab(c))
    back.forEach((v, i) => expect(v).toBeCloseTo(c[i], 5))
  })
})

describe('white balance', () => {
  it('is identity at zero', () => {
    const m = whiteBalanceMatrix(0, 0)
    expect(apply(m, [0.5, 0.2, 0.1])).toEqual([0.5, 0.2, 0.1])
  })
  it('warms with positive temperature and keeps gray luminance', () => {
    const g = apply(whiteBalanceMatrix(0.5, 0), [0.18, 0.18, 0.18])
    expect(g[0]).toBeGreaterThan(g[2])
    expect(0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]).toBeCloseTo(0.18, 3)
  })
  it('tint + goes magenta', () => {
    const g = apply(whiteBalanceMatrix(0, 0.5), [0.18, 0.18, 0.18])
    expect(g[1]).toBeLessThan(g[0])
    expect(g[1]).toBeLessThan(g[2])
  })
})

describe('Display P3', () => {
  it('keeps white and lands P3 red outside sRGB where the published matrix does', () => {
    for (const v of apply(P3_TO_SRGB, [1, 1, 1])) expect(v).toBeCloseTo(1, 4)
    const red = apply(P3_TO_SRGB, [1, 0, 0])
    ;[1.2249, -0.0421, -0.0196].forEach((want, k) => expect(red[k]).toBeCloseTo(want, 3))
  })
  it('goes back from sRGB exactly, and Rec. 2020 red lands where the published matrix does', () => {
    const back = apply(SRGB_TO_P3, apply(P3_TO_SRGB, [0.3, 0.6, 0.9]))
    ;[0.3, 0.6, 0.9].forEach((want, k) => expect(back[k]).toBeCloseTo(want, 6))
    const red = apply(REC2020_TO_SRGB, [1, 0, 0])
    ;[1.6605, -0.1246, -0.0182].forEach((want, k) => expect(red[k]).toBeCloseTo(want, 3))
    for (const v of apply(REC2020_TO_SRGB, [1, 1, 1])) expect(v).toBeCloseTo(1, 4)
  })
})

describe('curves', () => {
  it('monotone spline stays monotone and hits points', () => {
    const c = monotoneSpline([[0, 0], [0.25, 0.1], [0.5, 0.6], [1, 1]], 256)
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1] - 1e-6)
    expect(c[0]).toBeCloseTo(0)
    expect(c[255]).toBeCloseTo(1)
  })
  it('s-curve is monotone for both signs and fixes endpoints', () => {
    for (const k of [-1, -0.4, 0.3, 1]) {
      let prev = -1
      for (let i = 0; i <= 100; i++) {
        const y = sCurve(i / 100, k, 0.45)
        expect(y).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = y
      }
      expect(sCurve(0, k, 0.45)).toBeCloseTo(0, 6)
      expect(sCurve(1, k, 0.45)).toBeCloseTo(1, 6)
    }
  })
})

describe('looks', () => {
  it('calibration keeps neutrals neutral', () => {
    const m = calibrationMatrix({ redHue: 0.5, redSat: 0.3, greenHue: -0.4, greenSat: 0.2, blueHue: 0.3, blueSat: -0.2 })
    const g = apply(m, [0.4, 0.4, 0.4])
    g.forEach((v) => expect(v).toBeCloseTo(0.4, 6))
  })
  it.each(PRESETS.map((p) => [p.code, p]))('%s tone curves are monotone and in range under all dims', (_c, p) => {
    for (const d of [-1, 0, 1]) {
      const look = applyDims(resolveLook(p.look), { contrast: d, color: d, tone: d, character: d, warmth: d })
      const curves = buildToneCurves(look.tone, look.curve, look.channelCurves)
      for (let ch = 0; ch < 3; ch++) {
        let prev = -Infinity
        for (let i = 0; i < LOOK_CURVE_SIZE; i++) {
          const y = curves[ch * LOOK_CURVE_SIZE + i]
          expect(Number.isFinite(y)).toBe(true)
          expect(y).toBeGreaterThanOrEqual(prev - 1e-4)
          prev = y
        }
        expect(curves[ch * LOOK_CURVE_SIZE]).toBeGreaterThanOrEqual(0)
        expect(curves[ch * LOOK_CURVE_SIZE + LOOK_CURVE_SIZE - 1]).toBeLessThanOrEqual(1.1)
      }
    }
  })
})

describe('geometry', () => {
  it('identity crop maps output corners to source corners (v flipped)', () => {
    const e = defaultEdit(1)
    const m = outputToSource(e.crop, 400, 300)
    const tl = apply(m, [0, 1, 1]) // output top-left (v up)
    const br = apply(m, [1, 0, 1])
    expect(tl[0]).toBeCloseTo(0)
    expect(tl[1]).toBeCloseTo(0)
    expect(br[0]).toBeCloseTo(1)
    expect(br[1]).toBeCloseTo(1)
  })
  it('rot90 maps top-left of output to bottom-left of source', () => {
    const e = defaultEdit(1)
    e.crop.rot90 = 1
    const m = outputToSource(e.crop, 400, 300)
    const tl = apply(m, [0, 1, 1])
    expect(tl[0]).toBeCloseTo(0)
    expect(tl[1]).toBeCloseTo(1)
  })
  it('straighten auto-fit keeps corners inside the image', () => {
    const e = defaultEdit(1)
    const c = fitCropInRotation({ ...e.crop, straighten: 10 }, 600, 400)
    expect(c.w).toBeLessThan(1)
    const m = outputToSource(c, 600, 400)
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const p = apply(m, [u, v, 1])
      expect(p[0]).toBeGreaterThanOrEqual(-1e-3)
      expect(p[0]).toBeLessThanOrEqual(1 + 1e-3)
      expect(p[1]).toBeGreaterThanOrEqual(-1e-3)
      expect(p[1]).toBeLessThanOrEqual(1 + 1e-3)
    }
  })
})

import { applyAspect, cropInside, flip, rotate90, setStraighten } from '../model/crop'

describe('crop', () => {
  const base = defaultEdit(1).crop
  it('applies a ratio in pixel space', () => {
    const c = applyAspect(base, '1:1', 600, 400)
    expect((c.w * 600) / (c.h * 400)).toBeCloseTo(1, 4)
    expect(c.h).toBeCloseTo(1, 4)
  })
  it('rotating four times is identity', () => {
    let c = { ...base, x: 0.1, y: 0.2, w: 0.5, h: 0.3 }
    const start = c
    for (let i = 0; i < 4; i++) c = rotate90(c, 1)
    expect(c.x).toBeCloseTo(start.x)
    expect(c.y).toBeCloseTo(start.y)
    expect(c.w).toBeCloseTo(start.w)
    expect(c.rot90).toBe(0)
  })
  it('rotate right then left is identity and swaps a fixed ratio', () => {
    const c = { ...base, x: 0.1, y: 0.2, w: 0.5, h: 0.3, aspect: '4:5' }
    const r = rotate90(c, 1)
    expect(r.aspect).toBe('5:4')
    const back = rotate90(r, -1)
    expect(back.x).toBeCloseTo(c.x)
    expect(back.y).toBeCloseTo(c.y)
  })
  it('flip mirrors the rect and the angle', () => {
    const c = flip({ ...base, x: 0.1, w: 0.5, straighten: 5 }, 'h')
    expect(c.x).toBeCloseTo(0.4)
    expect(c.straighten).toBe(-5)
  })
  it('straighten shrinks a full crop and grows it back', () => {
    const tilted = setStraighten(base, 12, 600, 400)
    expect(tilted.w).toBeLessThan(0.9)
    expect(cropInside(tilted, 600, 400)).toBe(true)
    const back = setStraighten(tilted, 0, 600, 400)
    expect(back.w).toBeCloseTo(1, 3)
    expect(back.h).toBeCloseTo(1, 3)
  })
})
