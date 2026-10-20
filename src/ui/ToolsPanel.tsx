import { useState } from 'react'
import s from './Panel.module.css'
import t from './ToolsPanel.module.css'
import { HSL_BANDS, HSL_SWATCH, TOOL_GROUPS, type HslBand, type SliderDef, type ToolId } from '../model/edit'
import { useLibrary } from '../store/library'
import { Slider } from './Slider'
import { useEditSlider, useSelectionValue } from './useEditBinding'
import { CurveEditor } from './CurveEditor'
import { hueTrack, oklch } from './colorui'
import { HistoryPanel } from './HistoryPanel'
import { EffectsSections } from './EffectsSections'
import { getRenderer } from '../store/render'
import { isRawName } from '../engine/rawFormat'

export function ToolsPanel() {
  const count = useLibrary((st) => st.selected.length)
  if (!count) return <div className={s.none}>Select one or more photos to edit.</div>
  // The local tone tools run on a guided filter that needs half-float render targets.
  const localOff = getRenderer()?.halfTargets === false
  return (
    <div className={s.groups}>
      {localOff && <div className={s.hint}>This GPU has no half-float render targets, so Highlights, Shadows, Clarity and Texture have no effect here.</div>}
      {/* Light, Color, Effects, then the other sections. */}
      {TOOL_GROUPS.filter((g) => g.title !== 'Detail').map((g) => (
        <ToolGroup key={g.title} title={g.title} tools={g.tools} />
      ))}
      <EffectsSections />
      {TOOL_GROUPS.filter((g) => g.title === 'Detail').map((g) => (
        <ToolGroup key={g.title} title={g.title} tools={g.tools} />
      ))}
      <HslSection />
      <BwSection />
      <SplitSection />
      <div className={s.group}>
        <div className={s.groupTitle}>Curves</div>
        <CurveEditor />
      </div>
      <HistoryPanel />
    </div>
  )
}

function ToolGroup({ title, tools }: { title: string; tools: SliderDef<ToolId>[] }) {
  // RAW Exposure for RAW photos, and wherever it is set (edits pasted from a RAW photo), so it is never hidden.
  const raw = useLibrary((st) => st.photos.some((p) => st.selected.includes(p.id) && (isRawName(p.name) || !!p.edit.tools.rawExposure)))
  return (
    <div className={s.group}>
      <div className={s.groupTitle}>{title}</div>
      {tools
        .filter((def) => def.id !== 'rawExposure' || raw)
        .map((def) => (
          <ToolSlider key={def.id} def={def} />
        ))}
    </div>
  )
}

function ToolSlider({ def }: { def: SliderDef<ToolId> }) {
  const value = useSelectionValue((e) => e.tools[def.id])
  const bind = useEditSlider(def.label, (e, v) => (e.tools[def.id] = v))
  return <Slider label={def.label} value={value} bipolar={def.bipolar} scale={def.scale} gradient={def.gradient} {...bind} />
}

// ---------------------------------------------------------------- selective color

const BAND_HUE: Record<HslBand, number> = {
  red: 20,
  orange: 55,
  yellow: 100,
  green: 140,
  aqua: 190,
  blue: 250,
  purple: 295,
  magenta: 340,
}

function HslSection() {
  const [band, setBand] = useState<HslBand>('orange')
  const touched = useLibrary((st) => {
    const out: Partial<Record<HslBand, boolean>> = {}
    for (const id of st.selected) {
      const p = st.photos.find((x) => x.id === id)
      if (!p) continue
      for (const b of HSL_BANDS) {
        const v = p.edit.hsl[b]
        if (v.h || v.s || v.l) out[b] = true
      }
    }
    return JSON.stringify(out)
  })
  const touchedMap = JSON.parse(touched) as Partial<Record<HslBand, boolean>>
  const update = useLibrary((st) => st.updateEdits)
  const h = BAND_HUE[band]

  const hue = useSelectionValue((e) => e.hsl[band].h)
  const sat = useSelectionValue((e) => e.hsl[band].s)
  const lum = useSelectionValue((e) => e.hsl[band].l)
  const bh = useEditSlider(`HSL ${band} hue`, (e, v) => (e.hsl[band].h = v))
  const bs = useEditSlider(`HSL ${band} sat`, (e, v) => (e.hsl[band].s = v))
  const bl = useEditSlider(`HSL ${band} lum`, (e, v) => (e.hsl[band].l = v))

  return (
    <div className={s.group}>
      <div className={s.groupTitle}>
        Selective Color
        {Object.keys(touchedMap).length > 0 && (
          <button
            onClick={() =>
              update((e) => {
                for (const b of HSL_BANDS) e.hsl[b] = { h: 0, s: 0, l: 0 }
                return e
              }, 'Reset selective color')
            }
          >
            Reset
          </button>
        )}
      </div>
      <div className={t.swatches} role="radiogroup" aria-label="Color band">
        {HSL_BANDS.map((b) => (
          <button
            key={b}
            role="radio"
            aria-checked={band === b}
            aria-label={b}
            className={`${t.swatch} ${band === b ? t.swatchOn : ''}`}
            style={{ '--sw': HSL_SWATCH[b] } as React.CSSProperties}
            onClick={() => setBand(b)}
          >
            {touchedMap[b] && <span className={t.dot} />}
          </button>
        ))}
      </div>
      <Slider
        label="Hue"
        value={hue}
        bipolar
        scale={6}
        track={`linear-gradient(90deg, ${oklch(0.7, 0.14, h - 30)}, ${oklch(0.7, 0.14, h)}, ${oklch(0.7, 0.14, h + 30)})`}
        {...bh}
      />
      <Slider
        label="Saturation"
        value={sat}
        bipolar
        scale={6}
        track={`linear-gradient(90deg, ${oklch(0.7, 0.0, h)}, ${oklch(0.7, 0.07, h)}, ${oklch(0.7, 0.18, h)})`}
        {...bs}
      />
      <Slider
        label="Lightness"
        value={lum}
        bipolar
        scale={6}
        track={`linear-gradient(90deg, ${oklch(0.35, 0.1, h)}, ${oklch(0.65, 0.12, h)}, ${oklch(0.92, 0.06, h)})`}
        {...bl}
      />
    </div>
  )
}

// ---------------------------------------------------------------- split tone

function SplitSection() {
  const sh = useSelectionValue((e) => e.split.shadowHue / 360)
  const ss = useSelectionValue((e) => e.split.shadowSat)
  const hh = useSelectionValue((e) => e.split.highlightHue / 360)
  const hs = useSelectionValue((e) => e.split.highlightSat)
  const bal = useSelectionValue((e) => e.split.balance)
  const bsh = useEditSlider('Split shadow hue', (e, v) => (e.split.shadowHue = v * 360))
  const bss = useEditSlider('Split shadow sat', (e, v) => (e.split.shadowSat = v))
  const bhh = useEditSlider('Split highlight hue', (e, v) => (e.split.highlightHue = v * 360))
  const bhs = useEditSlider('Split highlight sat', (e, v) => (e.split.highlightSat = v))
  const bb = useEditSlider('Split balance', (e, v) => (e.split.balance = v))
  const track = hueTrack(0.72, 0.13)
  return (
    <div className={s.group}>
      <div className={s.groupTitle}>Split Tone</div>
      <div className={t.splitHead}>
        <span>Shadows</span>
        <span className={t.splitSwatch} style={{ background: oklch(0.6, 0.12 * ((ss ?? 0) + 0.15), (sh ?? 0) * 360) }} />
      </div>
      <Slider label="Hue" value={sh} bipolar={false} scale={360} defaultValue={220 / 360} track={track} {...bsh} />
      <Slider label="Intensity" value={ss} bipolar={false} scale={12} {...bss} />
      <div className={t.splitHead}>
        <span>Highlights</span>
        <span className={t.splitSwatch} style={{ background: oklch(0.8, 0.12 * ((hs ?? 0) + 0.15), (hh ?? 0) * 360) }} />
      </div>
      <Slider label="Hue" value={hh} bipolar={false} scale={360} defaultValue={45 / 360} track={track} {...bhh} />
      <Slider label="Intensity" value={hs} bipolar={false} scale={12} {...bhs} />
      <Slider label="Balance" value={bal} bipolar scale={6} {...bb} />
    </div>
  )
}

// ---------------------------------------------------------------- black & white

function BwSection() {
  const on = useLibrary((st) => {
    const p = st.photos.find((x) => x.id === (st.focus && st.selected.includes(st.focus) ? st.focus : st.selected[0]))
    return !!p?.edit.bw?.on
  })
  const update = useLibrary((st) => st.updateEdits)
  return (
    <div className={s.group}>
      <div className={s.groupTitle}>
        Black &amp; White
        <button onClick={() => update((e) => ({ ...e, bw: { ...(e.bw ?? { mix: [0, 0, 0, 0, 0, 0, 0, 0] }), on: !on } }), on ? 'Color' : 'Black & white')}>
          {on ? 'On' : 'Off'}
        </button>
      </div>
      {on &&
        HSL_BANDS.map((b, i) => (
          <BwSlider key={b} band={b} index={i} />
        ))}
    </div>
  )
}

function BwSlider({ band, index }: { band: HslBand; index: number }) {
  const value = useSelectionValue((e) => e.bw?.mix?.[index] ?? 0)
  const bind = useEditSlider(`B&W ${band}`, (e, v) => {
    e.bw = { on: true, mix: [...(e.bw?.mix ?? [0, 0, 0, 0, 0, 0, 0, 0])] }
    e.bw.mix[index] = v
  })
  const h = BAND_HUE[band]
  return (
    <Slider
      label={band}
      value={value}
      bipolar
      scale={6}
      track={`linear-gradient(90deg, ${oklch(0.25, 0.05, h)}, ${oklch(0.6, 0.14, h)}, ${oklch(0.93, 0.05, h)})`}
      {...bind}
    />
  )
}
