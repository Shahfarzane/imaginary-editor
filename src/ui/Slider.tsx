import { useEffect, useRef, useState } from 'react'
import s from './Slider.module.css'

export interface SliderProps {
  label: string
  /** Normalized value (-1..1 or 0..1); null means mixed across the selection. */
  value: number | null
  bipolar: boolean
  scale: number
  gradient?: [string, string, string]
  defaultValue?: number
  disabled?: boolean
  onBegin?: () => void
  onChange: (v: number) => void
  onCommit?: () => void
  /** Optional small control shown after the label (e.g. an expand chevron). */
  adornment?: React.ReactNode
  /** Full CSS background for the track, overrides gradient. */
  track?: string
}

const STEPS = 120

export const fmt = (v: number, scale: number) => {
  const n = Math.round(v * scale * 10) / 10
  return Object.is(n, -0) ? '0' : String(n)
}

export function Slider({
  label,
  value,
  bipolar,
  scale,
  gradient,
  defaultValue = 0,
  disabled,
  onBegin,
  onChange,
  onCommit,
  adornment,
  track,
}: SliderProps) {
  const min = bipolar ? -1 : 0
  // Clamped for display: an edit saved when the slider had a wider range can hold a value outside this one.
  const v = Math.max(min, Math.min(1, value ?? defaultValue))
  const [text, setText] = useState<string | null>(null)
  const cancelText = useRef(false)
  const dragging = useRef(false)

  useEffect(() => {
    const up = () => {
      if (dragging.current) {
        dragging.current = false
        onCommit?.()
      }
    }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [onCommit])

  const active = value !== null && Math.abs(v - defaultValue) > 1e-6
  // Neutral sliders fill from the center (bipolar) or the start (unipolar) to the thumb's center,
  // which travels from half a thumb in from each end.
  const neutral = !gradient && !track
  const at = (p: number) => `calc(var(--thumb-w) / 2 + (100% - var(--thumb-w)) * ${p})`
  const p = (v - min) / (1 - min)
  const [from, to] = bipolar ? (p >= 0.5 ? [at(0.5), at(p)] : [at(p), at(0.5)]) : ['0px', at(p)]

  const commitText = () => {
    if (cancelText.current) {
      cancelText.current = false
      setText(null)
      return
    }
    if (text === null) return
    const n = parseFloat(text)
    setText(null)
    if (Number.isFinite(n)) {
      const nv = Math.max(min, Math.min(1, n / scale))
      onBegin?.()
      onChange(nv)
      onCommit?.()
    }
  }

  return (
    <div className={`${s.root} ${active ? s.active : ''} ${disabled ? s.disabled : ''}`}>
      <div className={s.head}>
        <button
          className={s.label}
          aria-label={`Reset ${label} value to ${fmt(defaultValue, scale)}`}
          onClick={() => {
            onBegin?.()
            onChange(defaultValue)
            onCommit?.()
          }}
        >
          {label}
          {adornment}
        </button>
      </div>
      <div className={s.row}>
        <input
          className={`${s.range} ${neutral ? '' : s.colored}`}
          type="range"
          name={label}
          aria-label={label}
          min={min}
          max={1}
          step={1 / STEPS}
          value={v}
          aria-valuetext={`${label} value: ${value === null ? 'mixed' : fmt(v, scale)}`}
          style={
            neutral
              ? ({ '--from': from, '--to': to } as React.CSSProperties)
              : ({
                  '--g0': gradient?.[0],
                  '--g1': gradient?.[1],
                  '--g2': gradient?.[2],
                  ...(track ? { '--track': track } : {}),
                } as React.CSSProperties)
          }
          onPointerDown={() => {
            dragging.current = true
            onBegin?.()
          }}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          onDoubleClick={() => {
            onBegin?.()
            onChange(defaultValue)
            onCommit?.()
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <input
          className={s.number}
          type="number"
          aria-label={label}
          min={min * scale}
          max={scale}
          step={0.1}
          placeholder={value === null ? 'Mixed' : undefined}
          value={text ?? (value === null ? '' : fmt(v, scale))}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              // blur runs before React applies a state update, so cancellation must be synchronous.
              cancelText.current = true
              ;(e.target as HTMLInputElement).blur()
            }
            e.stopPropagation()
          }}
        />
      </div>
    </div>
  )
}
