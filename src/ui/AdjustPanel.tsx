import { useState } from 'react'
import s from './Panel.module.css'
import a from './AdjustPanel.module.css'
import { activePhoto, useLibrary } from '../store/library'
import { ASPECTS, applyAspect, flip, parseRatio, rotate90, setStraighten } from '../model/crop'
import { defaultEdit } from '../model/edit'
import { Slider } from './Slider'
import * as I from './icons'

export function AdjustPanel() {
  const photo = useLibrary(activePhoto)
  const update = useLibrary((st) => st.updateEdits)
  const begin = useLibrary((st) => st.begin)
  const commit = useLibrary((st) => st.commit)
  const [custom, setCustom] = useState('')
  if (!photo) return <div className={s.none}>Select a photo to crop and straighten.</div>
  const crop = photo.edit.crop
  // Each selected photo by its own size: the same normalized rectangle is another pixel ratio on another photo.
  const size = (id: string): [number, number] => {
    const p = useLibrary.getState().photos.find((x) => x.id === id)!
    return [p.width, p.height]
  }
  const setAspect = (aspect: string) => update((e, id) => ({ ...e, crop: applyAspect(e.crop, aspect, ...size(id)) }), 'Aspect')

  return (
    <div className={s.groups}>
      <div className={s.group}>
        <div className={s.groupTitle}>Aspect Ratio</div>
        <div className={a.ratios}>
          {ASPECTS.map((r) => {
            const tall = r.ratio! < 1
            const bw = tall ? 16 * r.ratio! : 16
            const bh = tall ? 16 : 16 / r.ratio!
            return (
              <button key={r.id} className={`${a.ratio} ${crop.aspect === r.id ? a.on : ''}`} onClick={() => setAspect(r.id)}>
                <span className={a.shape}>
                  <span style={{ width: bw, height: bh }} />
                </span>
                {r.label}
              </button>
            )
          })}
        </div>
        <div className={a.modes}>
          <button className={crop.aspect === 'original' ? a.modeOn : ''} onClick={() => setAspect('original')}>
            Original
          </button>
          <button className={crop.aspect === 'free' ? a.modeOn : ''} onClick={() => setAspect('free')}>
            Free-form
          </button>
        </div>
        <input
          className={a.custom}
          placeholder="Enter custom… (e.g. 7:5)"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              const r = parseRatio(custom)
              if (r) setAspect(custom.includes(':') ? custom.replace(/\s/g, '') : `${r}:1`)
              else useLibrary.getState().toast('Use a ratio like 7:5 or 1.85')
            }
          }}
        />
      </div>

      <div className={s.group}>
        <div className={s.groupTitle}>Rotate</div>
        <div className={a.iconRow}>
          <button aria-label="Rotate left" title="Rotate left" onClick={() => update((e) => ({ ...e, crop: rotate90(e.crop, -1) }), 'Rotate')}>
            <I.RotateLeft />
          </button>
          <button aria-label="Rotate right" title="Rotate right" onClick={() => update((e) => ({ ...e, crop: rotate90(e.crop, 1) }), 'Rotate')}>
            <I.RotateRight />
          </button>
          <button aria-label="Flip horizontal" title="Flip horizontal" onClick={() => update((e) => ({ ...e, crop: flip(e.crop, 'h') }), 'Flip')}>
            <I.FlipH />
          </button>
          <button aria-label="Flip vertical" title="Flip vertical" onClick={() => update((e) => ({ ...e, crop: flip(e.crop, 'v') }), 'Flip')}>
            <I.FlipV />
          </button>
        </div>
        <Slider
          label="Straighten"
          value={crop.straighten / 15}
          bipolar
          scale={15}
          onBegin={() => begin('Straighten')}
          onChange={(v) => update((e, id) => ({ ...e, crop: setStraighten(e.crop, Math.round(v * 150) / 10, ...size(id)) }), 'Straighten')}
          onCommit={commit}
        />
      </div>

      <div className={s.row}>
        <button className={s.pillBtn} onClick={() => update((e) => ({ ...e, crop: defaultEdit(e.seed).crop }), 'Reset crop')}>
          Reset
        </button>
        <button className={`${s.pillBtn} ${s.primary}`} onClick={() => useLibrary.getState().setPanel('tools')}>
          Done
        </button>
      </div>
    </div>
  )
}
