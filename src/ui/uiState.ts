import { create } from 'zustand'
import { NO_FILTER, type LibraryFilter } from '../model/filter'
import { panelShown, useLibrary } from '../store/library'

/** Zoom levels of the single view menu, as device pixels per image pixel (1 = 100%). */
export const ZOOM_LEVELS = [0.1, 0.3, 0.5, 1, 2, 3, 5, 10, 15]
export const ZOOM_MIN = ZOOM_LEVELS[0]
export const ZOOM_MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1]

interface UiState {
  /** The preset strip under the photo or the grid (remembered across visits; open on a first visit). */
  stripOpen: boolean
  setStripOpen: (v: boolean) => void
  shortcuts: boolean
  setShortcuts: (v: boolean) => void
  /** The command palette (Cmd+K). */
  palette: boolean
  setPalette: (v: boolean) => void
  exportOpen: boolean
  setExportOpen: (v: boolean) => void
  /** Split before/after view in single mode (0..1 divider position, null = off). */
  split: number | null
  setSplit: (v: number | null) => void
  /** Single view zoom: fit to the window, or device pixels per image pixel (1 = 100%). */
  zoom: 'fit' | number
  setZoom: (z: 'fit' | number) => void
  /** The scale "fit" currently resolves to, reported by the single view. */
  fitScale: number
  setFitScale: (s: number) => void
  /** Normalized point (0..1, top-left origin) to center the zoomed view on. */
  zoomAt: [number, number] | null
  setZoomAt: (p: [number, number] | null) => void
  /** Which photos the grid shows (favorites, edited, preset). */
  filter: LibraryFilter
  setFilter: (patch: Partial<LibraryFilter>) => void
}

const STRIP_KEY = 'studio.stripOpen'
function loadStripOpen() {
  try {
    return localStorage.getItem(STRIP_KEY) !== '0'
  } catch {
    return true
  }
}

export const useUi = create<UiState>((set) => ({
  stripOpen: loadStripOpen(),
  setStripOpen: (stripOpen) => {
    try {
      localStorage.setItem(STRIP_KEY, stripOpen ? '1' : '0')
    } catch {
      /* private mode: the choice lasts for this session */
    }
    set({ stripOpen })
  },
  shortcuts: false,
  setShortcuts: (shortcuts) => {
    // The list takes the side panel's place, so opening it closes the open panel.
    if (shortcuts) useLibrary.getState().setSidebar(false)
    set({ shortcuts })
  },
  palette: false,
  setPalette: (palette) => set({ palette }),
  exportOpen: false,
  setExportOpen: (exportOpen) => set({ exportOpen }),
  split: null,
  setSplit: (split) => set({ split }),
  zoom: 'fit',
  setZoom: (zoom) => set({ zoom: zoom === 'fit' ? 'fit' : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom)) }),
  fitScale: 1,
  setFitScale: (fitScale) => set({ fitScale }),
  zoomAt: null,
  setZoomAt: (zoomAt) => set({ zoomAt }),
  filter: NO_FILTER,
  setFilter: (patch) => set((u) => ({ filter: { ...u.filter, ...patch } })),
}))

// And a panel opening (rail, T, C, Cmd+I, Cmd+E, Cmd+B) closes the list. Store listeners run before React renders,
// so the list never shows over the panel.
useLibrary.subscribe((st, prev) => {
  if (panelShown(st) && !panelShown(prev) && useUi.getState().shortcuts) useUi.setState({ shortcuts: false })
})

/** Current zoom as a scale. */
export const zoomScale = (u: Pick<UiState, 'zoom' | 'fitScale'>) => (u.zoom === 'fit' ? u.fitScale : u.zoom)

/** Next menu level up or down from the current scale. */
/** Next zoom level up or down. Fit sits in the sequence at its own scale. */
export function stepZoom(dir: 1 | -1) {
  const u = useUi.getState()
  const cur = zoomScale(u)
  const levels: ('fit' | number)[] = [...ZOOM_LEVELS.filter((l) => Math.abs(l - u.fitScale) > 1e-3), 'fit']
  const scaleOf = (l: 'fit' | number) => (l === 'fit' ? u.fitScale : l)
  levels.sort((a, b) => scaleOf(a) - scaleOf(b))
  const next = dir > 0 ? levels.find((l) => scaleOf(l) > cur * 1.001) : [...levels].reverse().find((l) => scaleOf(l) < cur * 0.999)
  if (next === 'fit') u.setZoomAt(null)
  u.setZoom(next ?? (dir > 0 ? ZOOM_MAX : ZOOM_MIN))
}

export const zoomLabel = (z: 'fit' | number) => (z === 'fit' ? 'Fit' : `${Math.round(z * 100)}%`)
