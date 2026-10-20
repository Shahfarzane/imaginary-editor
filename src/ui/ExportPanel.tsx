import { useState } from 'react'
import s from './Panel.module.css'
import x from './ExportPanel.module.css'
import { activePhoto, useLibrary } from '../store/library'
import { getRenderer, useThumbs } from '../store/render'
import { exportContactSheet, exportCube, exportPhotos, is16Bit, type ExportFormat, type ExportOptions } from '../store/export'
import { getPreset } from '../model/presets'
import { Slider } from './Slider'
import { useUi } from './uiState'
import { tileOf } from '../model/strip'

const SIZES: { label: string; v: number | null }[] = [
  { label: 'Full', v: null },
  { label: '4096', v: 4096 },
  { label: '2048', v: 2048 },
  { label: '1080', v: 1080 },
]

export function useExportOptions() {
  const [opts, setOpts] = useState<ExportOptions>({ format: 'jpeg', quality: 0.92, longEdge: null, depth: 8 })
  return [opts, setOpts] as const
}

export function ExportPanel() {
  const selected = useLibrary((st) => st.selected)
  const photos = useLibrary((st) => st.photos)
  const active = useLibrary(activePhoto)
  const [opts, setOpts] = useExportOptions()
  const [progress, setProgress] = useState<{ f: number; label: string } | null>(null)
  const chosen = photos.filter((p) => selected.includes(p.id))
  const run = async () => {
    if (!chosen.length || progress) return
    setProgress({ f: 0, label: '' })
    try {
      await exportPhotos(chosen, opts, (f, label) => setProgress({ f, label }))
    } catch (e) {
      console.error(e)
      useLibrary.getState().toast(`Export failed: ${(e as Error).message}`)
    } finally {
      setProgress(null)
    }
  }

  if (!chosen.length) return <div className={s.none}>Select photos to export.</div>
  // 16-bit files render in float tiles; without float render targets they are not offered.
  const deep = getRenderer()?.floatTargets !== false

  return (
    <div className={s.groups}>
      <div className={s.group}>
        <div className={s.groupTitle}>Format</div>
        <div className={s.seg}>
          {(['jpeg', 'png', 'webp', ...(deep ? ['tiff'] : [])] as ExportFormat[]).map((f) => (
            <button key={f} aria-pressed={opts.format === f} onClick={() => setOpts({ ...opts, format: f })}>
              {f.toUpperCase()}
            </button>
          ))}
        </div>
        {opts.format === 'png' && deep && (
          <div className={s.seg} role="group" aria-label="Bit depth">
            {([8, 16] as const).map((d) => (
              <button key={d} aria-pressed={(opts.depth ?? 8) === d} onClick={() => setOpts({ ...opts, depth: d })}>
                {d}-bit
              </button>
            ))}
          </div>
        )}
        {is16Bit(opts) && <div className={s.hint}>16 bits per channel with an embedded color profile, for further editing. Files are several times larger.</div>}
        <div className={s.seg} role="group" aria-label="Color space">
          {(
            [
              ['srgb', 'sRGB'],
              ['display-p3', 'Display P3'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} aria-pressed={(opts.space ?? 'srgb') === v} onClick={() => setOpts({ ...opts, space: v })}>
              {label}
            </button>
          ))}
        </div>
        {opts.space === 'display-p3' && (
          <div className={s.hint}>Keeps colors beyond sRGB (iPhone photos, RAW) for wide-gamut screens and apps that read color profiles.</div>
        )}
        {(opts.format === 'jpeg' || opts.format === 'webp') && (
          <Slider
            label="Quality"
            value={(opts.quality - 0.5) / 0.5}
            bipolar={false}
            scale={100}
            defaultValue={0.84}
            onChange={(v) => setOpts({ ...opts, quality: 0.5 + v * 0.5 })}
          />
        )}
      </div>
      <div className={s.group}>
        <div className={s.groupTitle}>Size</div>
        <div className={s.seg}>
          {SIZES.map((z) => (
            <button key={z.label} aria-pressed={opts.longEdge === z.v} onClick={() => setOpts({ ...opts, longEdge: z.v })}>
              {z.label}
            </button>
          ))}
        </div>
        <div className={s.hint}>Long edge in pixels. Full renders every pixel of the original through the same pipeline you see.</div>
      </div>

      <div className={s.group}>
        <button className={`${s.pillBtn} ${s.primary}`} onClick={run} disabled={!!progress}>
          {progress ? `Exporting ${Math.round(progress.f * 100)}%` : `Export ${chosen.length} photo${chosen.length > 1 ? 's' : ''}`}
        </button>
        {progress && (
          <div className={x.bar}>
            <div style={{ width: `${progress.f * 100}%` }} />
          </div>
        )}
        {chosen.length > 1 && <div className={s.hint}>Multiple photos download as one .zip.</div>}
      </div>

      <div className={s.group}>
        <div className={s.groupTitle}>More</div>
        <button
          className={s.pillBtn}
          disabled={!active}
          onClick={async () => {
            if (!active) return
            const p = getPreset(active.edit.preset.id)
            try {
              await exportCube(active.edit, tileOf(active.edit.preset)?.full ?? (p ? p.name : 'Imaginary look'))
            } catch (e) {
              console.error(e)
              useLibrary.getState().toast(`Export failed: ${(e as Error).message}`)
            }
          }}
        >
          Export look as .cube LUT
        </button>
        <div className={s.hint}>Use this look in Resolve, Premiere, Final Cut or any LUT-aware app. Spatial effects (grain, halation, clarity) are not part of a LUT.</div>
        <button
          className={s.pillBtn}
          onClick={() => {
            exportContactSheet(chosen, useThumbs.getState().bitmaps, (preset) => tileOf(preset)?.code ?? null).catch((e) => {
              console.error(e)
              useLibrary.getState().toast(`Export failed: ${(e as Error).message}`)
            })
          }}
        >
          Contact sheet
        </button>
      </div>
    </div>
  )
}

/** The Cmd+E export dialog. */
export function ExportModal() {
  const open = useUi((u) => u.exportOpen)
  const setOpen = useUi((u) => u.setExportOpen)
  const selected = useLibrary((st) => st.selected)
  const photos = useLibrary((st) => st.photos)
  const [opts, setOpts] = useExportOptions()
  const [busy, setBusy] = useState<number | null>(null)
  if (!open) return null
  const chosen = photos.filter((p) => selected.includes(p.id))
  return (
    <div className={x.scrim} onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className={x.modal} role="dialog" aria-label="Export">
        <div className={x.title}>
          Export {chosen.length} photo{chosen.length === 1 ? '' : 's'}
        </div>
        <label className={x.check}>
          <input type="checkbox" checked={opts.longEdge === null} onChange={(e) => setOpts({ ...opts, longEdge: e.target.checked ? null : 2048 })} />
          Download full size
        </label>
        <label className={x.check}>
          <input type="checkbox" checked={opts.format === 'png'} onChange={(e) => setOpts({ ...opts, format: e.target.checked ? 'png' : 'jpeg' })} />
          Lossless PNG
        </label>
        <div className={x.actions}>
          <button className={x.btn} onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className={`${x.btn} ${x.primary}`}
            disabled={!chosen.length || busy !== null}
            onClick={async () => {
              setBusy(0)
              try {
                await exportPhotos(chosen, opts, (f) => setBusy(f))
                setOpen(false)
              } catch (e) {
                useLibrary.getState().toast(`Export failed: ${(e as Error).message}`)
              } finally {
                setBusy(null)
              }
            }}
          >
            {busy === null ? 'Save' : `${Math.round(busy * 100)}%`}
          </button>
        </div>
      </div>
    </div>
  )
}
