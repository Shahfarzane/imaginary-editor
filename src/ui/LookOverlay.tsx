import { useEffect, useRef } from 'react'
import s from './LookOverlay.module.css'
import { DIMS_FOR } from '../engine/look'
import { DIM_DEFS, type DimId, type Edit } from '../model/edit'
import { tileByCode } from '../model/presetOrder'
import { getPreset } from '../model/presets'
import { useCurrentTile } from './presetActions'
import { useEditSlider, useSelectionValue } from './useEditBinding'

/**
 * The selected look's sliders on top of the photo, bottom left. The photo in the single view is the
 * selected one, so they stay up for as long as it has a look; leaving it (Esc, back to the grid) is
 * how they go away.
 */
export function LookOverlay({ edit }: { edit: Edit }) {
  const preset = getPreset(edit.preset.id)
  if (!preset) return null
  return (
    <div className={s.overlay}>
      <div className={s.stack} onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <LookSliders dims={DIMS_FOR[preset.dims]} />
      </div>
    </div>
  )
}

/**
 * The selection's look sliders in the grid, in a card above the strip: the grid has no single photo to put
 * them on. They show while every selected photo shares the look.
 */
export function GridLook() {
  const current = useCurrentTile()
  const tile = current && current !== '__mixed' ? tileByCode(current) : null
  const preset = tile && getPreset(tile.look)
  if (!preset) return null
  return (
    <div className={s.card} onPointerDown={(e) => e.stopPropagation()}>
      <LookSliders dims={DIMS_FOR[preset.dims]} />
    </div>
  )
}

function LookSliders({ dims }: { dims: readonly DimId[] }) {
  return (
    <>
      <StrengthSlider />
      {dims.map((d) => (
        <DimSlider key={d} dim={d} />
      ))}
    </>
  )
}

function StrengthSlider() {
  const value = useSelectionValue((e) => e.preset.strength)
  const bind = useEditSlider('Strength', (e, v) => (e.preset.strength = v))
  return <OverlaySlider label="Strength" value={value} bipolar={false} scale={12} defaultValue={1} {...bind} />
}

function DimSlider({ dim }: { dim: DimId }) {
  const value = useSelectionValue((e) => e.preset.dims[dim])
  const bind = useEditSlider(`Dim ${dim}`, (e, v) => (e.preset.dims[dim] = v))
  return <OverlaySlider label={DIM_DEFS[dim].label} value={value} bipolar scale={6} {...bind} />
}

const STEPS = 120

function OverlaySlider({
  label,
  value,
  bipolar,
  scale,
  defaultValue = 0,
  onBegin,
  onChange,
  onCommit,
}: {
  label: string
  value: number | null
  bipolar: boolean
  scale: number
  defaultValue?: number
  onBegin?: () => void
  onChange: (v: number) => void
  onCommit?: () => void
}) {
  const min = bipolar ? -1 : 0
  const v = value ?? defaultValue
  const dragging = useRef(false)
  const n = Math.round(v * scale * 10) / 10
  const text = value === null ? 'Mixed' : `${bipolar && n > 0 ? '+' : ''}${(Object.is(n, -0) ? 0 : n).toFixed(1)}`

  useEffect(() => {
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      onCommit?.()
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [onCommit])

  const reset = () => {
    onBegin?.()
    onChange(defaultValue)
    onCommit?.()
  }

  return (
    <div className={s.slider}>
      <div className={s.head}>
        <button className={s.label} onClick={reset} aria-label={`Reset ${label}`}>
          {label}
        </button>
        <span className={s.value}>{text}</span>
      </div>
      <div className={`${s.track} ${bipolar ? s.bipolar : ''}`} style={{ '--p': (v - min) / (1 - min) } as React.CSSProperties}>
        <input
          className={s.range}
          type="range"
          aria-label={label}
          min={min}
          max={1}
          step={1 / STEPS}
          value={v}
          onPointerDown={() => {
            dragging.current = true
            onBegin?.()
          }}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          onDoubleClick={reset}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <span className={s.fill} />
        <span className={s.thumb} />
      </div>
    </div>
  )
}
