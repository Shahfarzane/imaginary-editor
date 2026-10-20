import { create } from 'zustand'
import { useLibrary } from '../store/library'

const STRIP_KEY = 'studio.presetsStrip'
const PANEL_KEY = 'studio.presetsPanel'
// The earlier switch that put the presets in a list instead of the strip: whoever had it on keeps that until they
// change these settings.
const LIST_KEY = 'studio.tmp.presetsSidebar'

function read(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, on: boolean) {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    /* private mode: the setting lasts for this session */
  }
}

function load() {
  const list = read(LIST_KEY) === '1'
  const strip = read(STRIP_KEY)
  const panel = read(PANEL_KEY)
  return { presetsStrip: strip === null ? !list : strip === '1', presetsPanel: panel === null ? list : panel === '1' }
}

interface Settings {
  /** The preset strip under the photo and the grid, with its rail button and P. */
  presetsStrip: boolean
  /** A Presets panel in the right sidebar, with its own rail button. */
  presetsPanel: boolean
  setPresetsStrip: (on: boolean) => void
  setPresetsPanel: (on: boolean) => void
}

/** Where the presets show: the strip, the Presets panel, or both. One of them always stays on. */
export const useSettings = create<Settings>((set, get) => ({
  ...load(),
  setPresetsStrip: (on) => {
    if (!on && !get().presetsPanel) return
    write(STRIP_KEY, on)
    set({ presetsStrip: on })
  },
  setPresetsPanel: (on) => {
    if (!on && !get().presetsStrip) return
    write(PANEL_KEY, on)
    set({ presetsPanel: on })
    // Turned off while it is open: no side panel is left.
    if (!on && useLibrary.getState().panel === 'presets') useLibrary.setState({ panel: 'none' })
  },
}))
