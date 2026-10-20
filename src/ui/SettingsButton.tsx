import { useEffect, useRef, useState } from 'react'
import r from './Rail.module.css'
import t from './SettingsButton.module.css'
import * as I from './icons'
import { tipOff } from './railTip'
import { useSettings } from './settings'
import { CREDIT } from './credit'

/** The rail's settings button, at its foot: where the presets show, the strip, the Presets panel or both. */
export function SettingsButton() {
  const strip = useSettings((s) => s.presetsStrip)
  const panel = useSettings((s) => s.presetsPanel)
  const setStrip = useSettings((s) => s.setPresetsStrip)
  const setPanel = useSettings((s) => s.setPresetsPanel)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

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
    <div ref={box} className={t.wrap}>
      <button
        className={r.btn}
        data-tip="Settings"
        aria-label="Settings"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        {...tipOff}
      >
        <I.Settings />
        {!open && <span className={r.tip}>Settings</span>}
      </button>
      {open && (
        <section className={t.menu} aria-label="Settings">
          <div className={t.head}>Settings</div>
          <Switch label="Preset strip" hint="Under the photo and the grid" on={strip} last={strip && !panel} onChange={setStrip} />
          <Switch label="Presets panel" hint="A Presets tab in the right sidebar" on={panel} last={panel && !strip} onChange={setPanel} />
          <div className={t.credit}>
            Made by{' '}
            <a href={CREDIT.url} target="_blank" rel="noopener">
              {CREDIT.name}
            </a>
          </div>
        </section>
      )}
    </div>
  )
}

/** One setting; the last place left for the presets cannot be turned off. */
function Switch({ label, hint, on, last, onChange }: { label: string; hint: string; on: boolean; last: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className={t.line}>
      <span className={t.text}>
        {label}
        <small>{last ? 'Presets need one place to show' : hint}</small>
      </span>
      <button className={t.switch} role="switch" aria-checked={on} aria-label={label} disabled={last} onClick={() => onChange(!on)}>
        <span />
      </button>
    </div>
  )
}
