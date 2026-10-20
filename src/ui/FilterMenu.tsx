import { useEffect, useRef, useState } from 'react'
import r from './Rail.module.css'
import s from './FilterMenu.module.css'
import * as I from './icons'
import { useLibrary } from '../store/library'
import { useUi } from './uiState'
import { filterActive, NO_FILTER, type LibraryFilter } from '../model/filter'
import { tileByCode } from '../model/presetOrder'
import { tileOf } from '../model/strip'
import { visiblePhotos } from './visible'
import { tipOff } from './railTip'

const EDITED: [LibraryFilter['edited'], string][] = [
  ['any', 'All'],
  ['edited', 'Edited'],
  ['unedited', 'Unedited'],
]

/** The rail's filter button: the grid's filters in a menu beside the rail, and a dot while one is on. */
export function FilterButton() {
  const hasPhotos = useLibrary((st) => st.photos.length > 0)
  const active = useUi((u) => filterActive(u.filter)) && hasPhotos
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // A press elsewhere or Escape closes the menu; Escape goes no further (it would clear the selection).
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
    }
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key, true)
    }
  }, [open])

  return (
    <div ref={box} className={s.wrap}>
      <button
        className={r.btn}
        data-tip="Filter"
        aria-label="Filter"
        aria-expanded={open}
        disabled={!hasPhotos}
        onClick={() => setOpen(!open)}
        {...tipOff}
      >
        <I.Filter />
        {active && <span className={r.dot} />}
        {!open && <span className={r.tip}>{active ? 'Filter on' : 'Filter'}</span>}
      </button>
      {open && <FilterMenu />}
    </div>
  )
}

/** The grid's filters: favorites, edited or not, and the preset a look came from. */
function FilterMenu() {
  const photos = useLibrary((st) => st.photos)
  const selected = useLibrary((st) => st.selected)
  const isolate = useLibrary((st) => st.isolate)
  const filter = useUi((u) => u.filter)
  const setFilter = useUi((u) => u.setFilter)
  const active = filterActive(filter)
  // Presets in use, in library order, for the preset filter.
  const used = [...new Set(photos.map((p) => tileOf(p.edit.preset)?.code).filter((c): c is string => !!c))]
  return (
    <section className={s.menu} aria-label="Filter">
      <div className={s.head}>
        <span className={s.title}>Filter</span>
        {active && (
          <span className={s.count}>
            {visiblePhotos(photos, selected, isolate, filter).length} of {photos.length}
          </span>
        )}
      </div>
      <div className={s.line}>
        <span className={s.label}>Favorites</span>
        <button
          className={`${s.icon} ${s.heart} ${filter.favorites ? s.on : ''}`}
          aria-pressed={filter.favorites}
          aria-label="Favorites only"
          title="Favorites only"
          onClick={() => setFilter({ favorites: !filter.favorites })}
        >
          <I.Heart width={16} />
        </button>
      </div>
      <div className={s.line}>
        <span className={s.segments} role="group" aria-label="Edited or not">
          {EDITED.map(([id, label]) => (
            <button key={id} aria-pressed={filter.edited === id} onClick={() => setFilter({ edited: id })}>
              {label}
            </button>
          ))}
        </span>
      </div>
      {used.length > 0 && (
        <div className={s.line}>
          <select className={s.select} aria-label="Preset" value={filter.preset ?? ''} onChange={(e) => setFilter({ preset: e.target.value || null })}>
            <option value="">Any preset</option>
            {used.map((code) => (
              <option key={code} value={code}>
                {code} {tileByCode(code)?.name ?? ''}
              </option>
            ))}
          </select>
        </div>
      )}
      {active && (
        <div className={s.line}>
          <button className={s.clear} onClick={() => setFilter(NO_FILTER)}>
            Clear filters
          </button>
        </div>
      )}
    </section>
  )
}
