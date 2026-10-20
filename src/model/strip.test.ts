import { describe, expect, it } from 'vite-plus/test'
import { PRESETS } from './presets'
import { STRIP, tileOf } from './strip'

describe('preset strip', () => {
  const tiles = STRIP.flatMap((s) => s.tiles)

  it('shows every catalog look, under unique codes', () => {
    const looks = new Set(tiles.map((t) => t.look))
    expect(PRESETS.filter((p) => !looks.has(p.id)).map((p) => p.id)).toEqual([])
    expect(new Set(tiles.map((t) => t.code)).size).toBe(tiles.length)
  })

  it('points every tile at a catalog look', () => {
    const ids = new Set(PRESETS.map((p) => p.id))
    expect(tiles.filter((t) => !ids.has(t.look)).map((t) => t.code)).toEqual([])
  })

  it('finds the tile a look was picked from, else its own tile', () => {
    const [tile, other] = tiles
    expect(tileOf({ id: tile.look, tile: tile.code })).toBe(tile)
    expect(tileOf({ id: tile.look })).toBe(tile)
    // A pick that names another look's tile is ignored.
    expect(tileOf({ id: tile.look, tile: other.code })).toBe(tile)
    expect(tileOf({ id: null })).toBeNull()
  })
})
