import { STRIP, type StripTile } from './strip'

// The presets in the catalog's order, set by set, as the strip shows them.

const byCode = new Map<string, StripTile>()
for (const set of STRIP) for (const t of set.tiles) byCode.set(t.code, t)

export const DEFAULT_ORDER: string[] = STRIP.flatMap((s) => s.tiles.map((t) => t.code))

export const tileByCode = (code: string) => byCode.get(code)

/** The catalog's sets with their tiles, in order. */
export const orderedSets = (): { title: string; codes: string[] }[] =>
  STRIP.map((set) => ({ title: set.title, codes: set.tiles.map((t) => t.code) }))
