import { describe, expect, it } from 'vite-plus/test'
import { moveItem, normalizeOrder, placeItem } from './order'

describe('orders', () => {
  it('moves an item before or after another', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 'd', 'b', false)).toEqual(['a', 'd', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c', 'd'], 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd'])
    expect(moveItem(['a', 'b', 'c'], 'b', 'b', true)).toEqual(['a', 'b', 'c'])
    expect(moveItem(['a', 'b', 'c'], 'b', 'x', true)).toEqual(['a', 'b', 'c'])
  })

  it('places a new or known item next to a target, or at the end', () => {
    expect(placeItem(['a', 'b'], 'x', 'a', true)).toEqual(['a', 'x', 'b'])
    expect(placeItem(['a', 'b'], 'x', 'a', false)).toEqual(['x', 'a', 'b'])
    expect(placeItem(['a', 'b', 'c'], 'c', 'a', false)).toEqual(['c', 'a', 'b'])
    expect(placeItem(['a'], 'x', null, false)).toEqual(['a', 'x'])
  })

  it('cleans a saved order and slots in items it does not know', () => {
    const all = ['a', 'b', 'c', 'd', 'e']
    // "b" follows "a" and "d" follows "c", their neighbors in the full list.
    expect(normalizeOrder(['c', 'a', 'zz', 'c', 'e'], all)).toEqual(['c', 'd', 'a', 'b', 'e'])
    expect(normalizeOrder([], all)).toEqual(all)
    expect(normalizeOrder(['e', 'd', 'c', 'b'], all)).toEqual(['a', 'e', 'd', 'c', 'b'])
  })
})
