import { matchesFilter, type LibraryFilter } from '../model/filter'
import { tileOf } from '../model/strip'
import type { Photo } from '../store/library'

const presetCode = (e: Photo['edit']) => tileOf(e.preset)?.code ?? null

/** The photos the grid shows and the arrow keys step through: the isolated selection, then the filter. */
export function visiblePhotos(photos: Photo[], selected: string[], isolate: boolean, filter: LibraryFilter): Photo[] {
  const base = isolate ? photos.filter((p) => selected.includes(p.id)) : photos
  return base.filter((p) => matchesFilter(p, filter, presetCode))
}
