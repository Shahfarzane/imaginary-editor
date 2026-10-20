import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import './styles/global.css'
import App from './App'
import { useLibrary } from './store/library'
import { onSlidersReady } from './model/presets'
import { toolTablesLoaded } from './model/toolData'
import { STAGED_TOOLS } from './engine/tools'
import { getRenderer, requestThumb } from './store/render'
import { useUi } from './ui/uiState'
import { usePreview } from './ui/preview'

if (import.meta.env.DEV) {
  // Test hook for scripted browser checks. Not present in production builds.
  Object.assign(window, { __studio: { lib: useLibrary, ui: useUi, renderer: getRenderer } })
  void import('./dev/lookStats').then((m) => Object.assign((window as unknown as { __studio: object }).__studio, m))
}

// Photos whose preset sliders or table-driven tools are already moved re-render
// once the tables for them arrive (until then they use the built-in formulas).
const touch = (moved: (p: ReturnType<typeof useLibrary.getState>['photos'][number]) => boolean) => {
  const ids: string[] = []
  useLibrary.setState((s) => ({
    photos: s.photos.map((p) => {
      if (!moved(p)) return p
      ids.push(p.id)
      return { ...p, edit: { ...p.edit } }
    }),
  }))
  ids.forEach(requestThumb)
}
onSlidersReady((id) =>
  touch((p) => p.edit.preset.id === id || (usePreview.getState().id === id && useLibrary.getState().focus === p.id)),
)
void toolTablesLoaded.then(() => touch((p) => STAGED_TOOLS.some((id) => p.edit.tools[id] !== 0)))

const root = createRoot(document.getElementById('root')!)
// `?bench` times the engine in this browser on a synthetic photo, without opening the library.
if (new URLSearchParams(location.search).has('bench'))
  void import('./bench').then(({ default: Bench }) => root.render(<Bench />))
else
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
