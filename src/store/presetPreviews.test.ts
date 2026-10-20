import { describe, expect, it } from 'vite-plus/test'
import { baseKey, coverRect, previewEdit } from './presetPreviews'
import { defaultEdit } from '../model/edit'

describe('preset previews', () => {
  it('crop a preview to fill its tile, centered', () => {
    // A landscape photo in a portrait tile: full height, the middle of the width.
    expect(coverRect(160, 100, 0.8)).toEqual([40, 0, 80, 100])
    // A portrait photo in a wider tile: full width, the middle of the height.
    expect(coverRect(100, 160, 1)).toEqual([0, 30, 100, 100])
    expect(coverRect(80, 100, 0.8)).toEqual([0, 0, 80, 100])
  })
  it('depend on the photo edit without its preset', () => {
    const a = defaultEdit(1)
    const b = { ...a, preset: { ...a.preset, id: 'pr1', strength: 0.4 } }
    expect(baseKey(b)).toBe(baseKey(a))
    expect(baseKey({ ...a, tools: { ...a.tools, exposure: 0.3 } })).not.toBe(baseKey(a))
  })
  it('show a look at its defaults over the rest of the edit', () => {
    const e = defaultEdit(1)
    e.preset = { id: 'no1', strength: 0.3, dims: { contrast: 1, color: 0, tone: 0, character: 0, warmth: 0 } }
    e.tools.exposure = 0.5
    const p = previewEdit(e, 'pr1')
    expect(p.preset).toEqual({ id: 'pr1', strength: 1, dims: { contrast: 0, color: 0, tone: 0, character: 0, warmth: 0 } })
    expect(p.tools.exposure).toBe(0.5)
  })
})
