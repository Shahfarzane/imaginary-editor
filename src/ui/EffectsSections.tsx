import s from './Panel.module.css'
import t from './ToolsPanel.module.css'
import { FX_GROUPS, type BorderKind, type FxId, type SliderDef } from '../model/edit'
import { useLibrary, activePhoto } from '../store/library'
import { Slider } from './Slider'
import { useEditSlider, useSelectionValue } from './useEditBinding'
import * as I from './icons'

/** Grain and the film effects, as groups inside the Tools panel. */
export function EffectsSections() {
  const update = useLibrary((st) => st.updateEdits)
  return (
    <>
      {FX_GROUPS.map((g) => (
        <div key={g.title} className={s.group}>
          <div className={s.groupTitle}>
            {g.title}
            {(g.title === 'Effects' || g.title === 'Light Leak' || g.title === 'Dust') && (
              <button
                title="New random pattern (R)"
                aria-label={`Reroll ${g.title}`}
                onClick={() => update((e) => ({ ...e, seed: Math.floor(Math.random() * 1e6) }), 'Reroll')}
                style={{ display: 'flex' }}
              >
                <I.Dice width={18} height={18} />
              </button>
            )}
          </div>
          {g.tools.map((def) => (
            <FxSlider key={def.id} def={def} />
          ))}
        </div>
      ))}
      <BorderSection />
    </>
  )
}

function FxSlider({ def }: { def: SliderDef<FxId> }) {
  const value = useSelectionValue((e) => e.fx[def.id])
  const bind = useEditSlider(def.label + def.id, (e, v) => (e.fx[def.id] = v))
  return <Slider label={def.label} value={value} bipolar={def.bipolar} scale={def.scale} gradient={def.gradient} {...bind} />
}

const BORDERS: { id: BorderKind; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'solid', label: 'Solid' },
  { id: 'film35', label: '35mm' },
  { id: 'medium', label: '120' },
  { id: 'instant', label: 'Instant' },
]
const BORDER_COLORS = ['#ffffff', '#f1ece2', '#111111', '#000000', '#d8d2c4']

function BorderSection() {
  const photo = useLibrary(activePhoto)
  const update = useLibrary((st) => st.updateEdits)
  const size = useSelectionValue((e) => e.border.size)
  const bind = useEditSlider('Border size', (e, v) => (e.border.size = v))
  const kind = photo?.edit.border.kind ?? 'none'
  return (
    <div className={s.group}>
      <div className={s.groupTitle}>Border</div>
      <div className={s.seg}>
        {BORDERS.map((b) => (
          <button
            key={b.id}
            aria-pressed={kind === b.id}
            onClick={() => update((e) => ({ ...e, border: { ...e.border, kind: b.id } }), 'Border')}
          >
            {b.label}
          </button>
        ))}
      </div>
      {kind !== 'none' && (
        <>
          <Slider label="Size" value={size} bipolar={false} scale={12} defaultValue={0.5} {...bind} />
          {(kind === 'solid' || kind === 'instant') && (
            <div className={t.borderColors}>
              {BORDER_COLORS.map((c) => (
                <button
                  key={c}
                  className={t.borderColor}
                  aria-label={`Border color ${c}`}
                  aria-pressed={photo?.edit.border.color === c}
                  onClick={() => update((e) => ({ ...e, border: { ...e.border, color: c } }), 'Border color')}
                  style={{ '--c': c } as React.CSSProperties}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
