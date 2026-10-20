import s from './Panel.module.css'
import { useLibrary } from '../store/library'
import { ToolsPanel } from './ToolsPanel'
import { AdjustPanel } from './AdjustPanel'
import { ExportPanel } from './ExportPanel'
import { InfoPanel } from './InfoPanel'
import { PresetsPanel } from './PresetsPanel'
import { Histogram } from './Histogram'
import { ShortcutsOverlay } from './ShortcutsOverlay'

// 'none' only gets here under the shortcuts list, which covers the panel.
const TITLES = { none: '', presets: 'Presets', tools: 'Tools', adjust: 'Adjust', export: 'Export', info: 'Info' }

export function PanelHost() {
  const panel = useLibrary((st) => st.panel)
  const count = useLibrary((st) => st.selected.length)
  const single = useLibrary((st) => st.gridSize >= 0.99)
  return (
    <aside className={s.panel} aria-label={TITLES[panel]}>
      <header className={s.title}>
        <div className={s.titleText}>{TITLES[panel]}</div>
        {/* The panel only shows with a selection (panelShown). */}
        <div className={s.subtitle}>{count === 1 ? '1 photo' : `${count} photos`}</div>
        {panel === 'tools' && single && (
          <div className={s.titleExtra}>
            <Histogram />
          </div>
        )}
      </header>
      <div className={s.scroll}>
        {panel === 'presets' && <PresetsPanel />}
        {panel === 'tools' && <ToolsPanel />}
        {panel === 'adjust' && <AdjustPanel />}
        {panel === 'export' && <ExportPanel />}
        {panel === 'info' && <InfoPanel />}
      </div>
      <ShortcutsOverlay />
    </aside>
  )
}
