import { describe, expect, it } from 'vite-plus/test'
import { defaultEdit, hasEdits, isUnedited, originalWithCrop } from './edit'

describe('original photo', () => {
  it('a fresh edit is unedited, whatever the crop', () => {
    const e = defaultEdit(7)
    expect(isUnedited(e)).toBe(true)
    e.crop = { ...e.crop, x: 0.1, w: 0.8, straighten: 3 }
    expect(isUnedited(e)).toBe(true)
  })

  it('tools, looks, curves and borders count as edits', () => {
    const tool = defaultEdit(1)
    tool.tools.exposure = 0.2
    const look = defaultEdit(1)
    look.preset.id = 'kp1'
    const curve = defaultEdit(1)
    curve.curves.rgb = [
      [0, 0.05],
      [1, 1],
    ]
    const border = defaultEdit(1)
    border.border.kind = 'film35'
    for (const e of [tool, look, curve, border]) expect(isUnedited(e)).toBe(false)
  })

  it('going back to the original clears every edit but keeps the crop and seed', () => {
    const e = defaultEdit(42)
    e.tools.exposure = 0.3
    e.preset = { id: 'kp1', strength: 0.5, dims: { contrast: 0.2, color: 0, tone: 0, character: 0, warmth: 0 } }
    e.fx.grain = 0.4
    e.crop = { ...e.crop, x: 0.2, w: 0.6 }
    const o = originalWithCrop(e)
    expect(isUnedited(o)).toBe(true)
    expect(o.crop).toEqual(e.crop)
    expect(o.seed).toBe(42)
  })
})

describe('edited badge', () => {
  it('a fresh photo has no edits', () => {
    expect(hasEdits(defaultEdit(3))).toBe(false)
  })
  it('a crop, rotation or flip alone counts', () => {
    const changes: Partial<ReturnType<typeof defaultEdit>['crop']>[] = [{ w: 0.8 }, { rot90: 1 }, { straighten: -2 }, { flipH: true }]
    for (const change of changes) {
      const e = defaultEdit(3)
      e.crop = { ...e.crop, ...change }
      expect(hasEdits(e)).toBe(true)
    }
  })
  it('a look or a tool counts', () => {
    const e = defaultEdit(3)
    e.tools.contrast = -0.1
    expect(hasEdits(e)).toBe(true)
  })
})
