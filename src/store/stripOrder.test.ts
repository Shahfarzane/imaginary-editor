import { beforeEach, describe, expect, it } from 'vite-plus/test'
import { STRIP } from '../model/strip'
import { isCustomOrder, orderedGroups, useStripOrder } from './stripOrder'
import type { Collection } from './collections'

const [first, second] = STRIP[0].tiles.map((t) => t.code)
const mine: Collection = { id: 'c1', name: 'Mine', codes: [second, 'gone', first] }
const titles = STRIP.map((s) => s.title)

describe('strip order', () => {
  beforeEach(() => useStripOrder.getState().reset())

  it('puts collections first, then the sets in catalog order, dropping codes the catalog lost', () => {
    const groups = orderedGroups([mine], useStripOrder.getState())
    expect(groups.map((g) => g.key)).toEqual(['c1', ...titles])
    expect(groups[0].codes).toEqual([second, first])
    expect(isCustomOrder(useStripOrder.getState())).toBe(false)
  })

  it('keeps moved groups and presets, and a new collection starts at the front', () => {
    const O = useStripOrder.getState()
    const keys = orderedGroups([mine], O).map((g) => g.key)
    O.moveGroup(keys, 'c1', titles[0], true)
    O.moveInSet(titles[0], STRIP[0].tiles[0].code, STRIP[0].tiles[2].code, true)
    const fresh: Collection = { id: 'c2', name: 'New', codes: [] }
    const groups = orderedGroups([mine, fresh], useStripOrder.getState())
    expect(groups.map((g) => g.key)).toEqual(['c2', titles[0], 'c1', ...titles.slice(1)])
    const codes = STRIP[0].tiles.map((t) => t.code)
    expect(groups[1].codes).toEqual([codes[1], codes[2], codes[0], ...codes.slice(3)])
    expect(isCustomOrder(useStripOrder.getState())).toBe(true)
    useStripOrder.getState().reset()
    expect(orderedGroups([mine], useStripOrder.getState()).map((g) => g.key)).toEqual(['c1', ...titles])
  })
})
