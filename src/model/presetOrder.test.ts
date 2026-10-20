import { describe, expect, it } from 'vite-plus/test'
import { DEFAULT_ORDER, orderedSets } from './presetOrder'
import { STRIP } from './strip'

describe('preset order', () => {
  it('keeps the sets and their tiles in catalog order', () => {
    const sets = orderedSets()
    expect(sets.map((g) => g.title)).toEqual(STRIP.map((set) => set.title))
    expect(sets.flatMap((g) => g.codes)).toEqual(DEFAULT_ORDER)
    expect(new Set(DEFAULT_ORDER).size).toBe(DEFAULT_ORDER.length)
  })
})
