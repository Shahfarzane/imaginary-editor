import { describe, expect, it } from 'vite-plus/test'
import { buildRenderSpec } from './params'
import { NEUTRAL_LOOK } from './look'
import { defaultEdit } from '../model/edit'

describe('neutral render spec', () => {
  const spec = (change: (e: ReturnType<typeof defaultEdit>) => void = () => {}) => {
    const e = defaultEdit(1)
    change(e)
    return buildRenderSpec(e, () => NEUTRAL_LOOK)
  }

  it('holds for an unedited photo, cropped or not', () => {
    expect(spec().neutral).toBe(true)
    expect(spec((e) => (e.crop = { ...e.crop, x: 0.1, w: 0.8, straighten: 3 })).neutral).toBe(true)
    // Unused split-tone hues and the seed change no colors.
    expect(spec((e) => (e.split.shadowHue = 10)).neutral).toBe(true)
  })

  it('ends with any look, color tool or effect', () => {
    expect(spec((e) => (e.preset.id = 'any')).neutral).toBe(false)
    expect(spec((e) => (e.tools.contrast = 0.1)).neutral).toBe(false)
    expect(spec((e) => (e.tools.shadows = 0.1)).neutral).toBe(false)
    expect(spec((e) => (e.tools.rawExposure = 0.1)).neutral).toBe(false)
    expect(spec((e) => (e.fx.grain = 0.1)).neutral).toBe(false)
    expect(spec((e) => (e.fx.vignette = -0.1)).neutral).toBe(false)
    expect(spec((e) => (e.split.highlightSat = 0.1)).neutral).toBe(false)
    expect(spec((e) => (e.hsl.blue.s = 0.1)).neutral).toBe(false)
    expect(spec((e) => (e.bw.on = true)).neutral).toBe(false)
    expect(spec((e) => (e.curves.rgb = [[0, 0.05], [1, 1]])).neutral).toBe(false)
  })
})
