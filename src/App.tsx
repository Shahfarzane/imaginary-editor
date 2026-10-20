import { lazy, Suspense, useEffect, useState } from 'react'
import s from './App.module.css'
import { LeftRail } from './ui/LeftRail'
import { Library } from './ui/Library'
import { PanelHost } from './ui/PanelHost'
import { panelShown, useLibrary } from './store/library'
import { useShortcuts } from './ui/useShortcuts'
import { Toasts } from './ui/Toasts'
import { DropZone } from './ui/DropZone'
import { gpuSupported } from './store/render'
import { ExportModal } from './ui/ExportPanel'
import { SelectionBar } from './ui/SelectionBar'
import { useUi } from './ui/uiState'
// The command palette (and Base UI) loads on the first Cmd+K, then stays mounted so it can animate out.
const CommandPalette = lazy(() => import('./ui/CommandPalette').then((m) => ({ default: m.CommandPalette })))

export default function App() {
  const init = useLibrary((st) => st.init)
  const panel = useLibrary((st) => st.panel)
  // The shortcuts list opens inside the panel, so it shows the panel too.
  const shortcuts = useUi((u) => u.shortcuts)
  const sidebar = useLibrary(panelShown) || shortcuts
  useEffect(() => {
    void init()
  }, [init])
  useShortcuts()
  const palette = useUi((u) => u.palette)
  const [paletteUsed, setPaletteUsed] = useState(false)
  if (palette && !paletteUsed) setPaletteUsed(true)

  const gpuOk = gpuSupported()

  const columns = ['var(--rail-w)', 'minmax(0, 1fr)', sidebar && 'var(--panel-w)']
  return (
    <div className={s.app} style={{ gridTemplateColumns: columns.filter(Boolean).join(' ') }} data-panel={panel}>
      <LeftRail />
      <div className={s.center}>
        <main className={s.canvas}>
          {gpuOk && <SelectionBar />}
          {gpuOk ? (
            <Library />
          ) : (
            <div className={s.fatal}>This editor needs WebGL2. Try a current Chrome, Safari or Firefox.</div>
          )}
        </main>
      </div>
      {sidebar && <PanelHost />}
      <DropZone />
      <Toasts />
      <ExportModal />
      {paletteUsed && (
        <Suspense>
          <CommandPalette />
        </Suspense>
      )}
    </div>
  )
}
