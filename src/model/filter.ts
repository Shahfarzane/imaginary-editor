import { hasEdits, type Edit } from './edit'

/** Which photos the grid shows. The default shows every photo. */
export interface LibraryFilter {
  favorites: boolean
  edited: 'any' | 'edited' | 'unedited'
  /** Preset strip code the photo's look was picked from, or null for any. */
  preset: string | null
}

export const NO_FILTER: LibraryFilter = { favorites: false, edited: 'any', preset: null }

export const filterActive = (f: LibraryFilter) =>
  f.favorites || f.edited !== 'any' || f.preset !== null

type Filterable = { favorite?: boolean; edit: Edit }

export function matchesFilter(p: Filterable, f: LibraryFilter, presetCode: (e: Edit) => string | null): boolean {
  if (f.favorites && !p.favorite) return false
  if (f.edited !== 'any' && hasEdits(p.edit) !== (f.edited === 'edited')) return false
  if (f.preset !== null && presetCode(p.edit) !== f.preset) return false
  return true
}
