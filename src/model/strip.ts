import { LEGACY_TILE_CODES, STRIP_SETS } from './stripCatalog'

/** One strip tile: a catalog look under our code and name. */
export interface StripTile {
  code: string
  /** Shown under the tile. */
  name: string
  /** Tooltip and exports: film tiles add their film brand. */
  full: string
  /** Catalog preset id. */
  look: string
  /** A slider version (Contrast, Color and Tone) of a look that also has a plain tile: the Studio set's tiles. */
  pro?: boolean
}

export interface StripSet {
  title: string
  prefix: string
  tiles: StripTile[]
}

/** The strip, set by set, in order. Titles are for tools and review; the strip shows none. */
export const STRIP: StripSet[] = STRIP_SETS

const byCode = new Map<string, StripTile>()
const byLook = new Map<string, StripTile>()
for (const set of STRIP)
  for (const t of set.tiles) {
    byCode.set(t.code, t)
    // A look's own tile is its first plain one.
    const seen = byLook.get(t.look)
    if (!seen || (seen.pro && !t.pro)) byLook.set(t.look, t)
  }

/** A tile code as the catalog has it now: Studio tiles saved under their old codes (a base code with a +) map over. */
export const currentCode = (code: string) => LEGACY_TILE_CODES[code] ?? code

/** The tile a preset shows as: the one it was picked from, else its look's own tile. */
export function tileOf(preset: { id: string | null; tile?: string }): StripTile | null {
  if (!preset.id) return null
  const picked = preset.tile ? byCode.get(currentCode(preset.tile)) : undefined
  return picked?.look === preset.id ? picked : (byLook.get(preset.id) ?? null)
}
