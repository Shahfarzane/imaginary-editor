import { useEffect, useMemo } from 'react'
import ps from './Panel.module.css'
import s from './InfoPanel.module.css'
import * as I from './icons'
import { activePhoto, useLibrary } from '../store/library'
import { shutter } from '../model/photoInfo'
import { hasEdits } from '../model/edit'
import { tileOf } from '../model/strip'

/** Favorite for the selection, then the active photo's file and camera facts. */
export function InfoPanel() {
  const photo = useLibrary(activePhoto)
  // Select the parts and derive the list: a selector that builds a new array each time re-renders forever.
  const photos = useLibrary((st) => st.photos)
  const selected = useLibrary((st) => st.selected)
  const selection = useMemo(() => photos.filter((p) => selected.includes(p.id)), [photos, selected])
  const toggleFavorite = useLibrary((st) => st.toggleFavorite)
  const ensureInfo = useLibrary((st) => st.ensureInfo)

  useEffect(() => {
    if (photo && !photo.info) ensureInfo(photo.id).catch((e) => console.error(e))
  }, [photo, ensureInfo])

  if (!photo) return null
  const favorite = selection.every((p) => p.favorite)
  const info = photo.info
  const tile = tileOf(photo.edit.preset)
  const mp = (photo.width * photo.height) / 1e6
  const rows: [string, string | undefined][] = [
    ['File', photo.name],
    ['Size', `${photo.width} × ${photo.height} (${mp.toFixed(1)} MP)`],
    ['Format', info?.format],
    ['File size', info ? `${(info.fileSize / 1e6).toFixed(1)} MB` : undefined],
    ['Camera', [info?.make, info?.model].filter(Boolean).join(' ') || undefined],
    ['Lens', info?.lens],
    ['Focal length', info?.focalLength ? `${+info.focalLength.toFixed(1)} mm` : undefined],
    ['Aperture', info?.fNumber ? `f/${+info.fNumber.toFixed(1)}` : undefined],
    ['Shutter', info?.exposureTime ? shutter(info.exposureTime) : undefined],
    ['ISO', info?.iso ? String(info.iso) : undefined],
    ['Taken', info?.taken?.replace('T', ' ')],
    ['Look', tile ? `${tile.code} ${tile.name}` : hasEdits(photo.edit) ? 'Edited, no preset' : 'Unedited'],
  ]
  return (
    <div className={ps.groups}>
      <div className={ps.group}>
        <div className={ps.groupTitle}>{selection.length > 1 ? `${selection.length} photos` : 'Favorite'}</div>
        <div className={s.rate}>
          <button className={`${s.heart} ${favorite ? s.on : ''}`} aria-pressed={favorite} aria-label="Favorite" title="Favorite (.)" onClick={toggleFavorite}>
            <I.Heart width={20} />
          </button>
        </div>
      </div>
      <div className={ps.group}>
        <div className={ps.groupTitle}>{selection.length > 1 ? 'Active photo' : 'Photo'}</div>
        <dl className={s.facts}>
          {rows
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k} className={s.row}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
        {!info && <div className={s.note}>Reading the file…</div>}
        {info && !info.make && !info.model && <div className={s.note}>No camera details in this file.</div>}
      </div>
    </div>
  )
}
