import { useRef, useState } from 'react'
import s from './Rail.module.css'
import c from './controls.module.css'
import * as I from './icons'
import { inCrop, inSingleView, panelShown, useLibrary, type PanelId } from '../store/library'
import { openFilePicker } from './DropZone'
import { useUi, zoomLabel, zoomScale, ZOOM_LEVELS, ZOOM_MAX, ZOOM_MIN } from './uiState'
import { stripShown, toggleStrip } from './PresetStrip'
import { FilterButton } from './FilterMenu'
import { tipOff } from './railTip'
import { NO_FILTER } from '../model/filter'
import { SettingsButton } from './SettingsButton'
import { useSettings } from './settings'

function RailButton({
  tip,
  kbd,
  onClick,
  disabled,
  pressed,
  children,
}: {
  tip: string
  kbd?: string
  onClick: () => void
  disabled?: boolean
  /** A toggle that is on: drawn like the open panel's button. */
  pressed?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      className={`${s.btn} ${pressed ? `${s.tab} ${s.tabOn}` : ''}`}
      data-tip={tip}
      aria-label={tip}
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      {...tipOff}
    >
      {children}
      <span className={s.tip}>
        {tip}
        {kbd && <kbd>{kbd}</kbd>}
      </span>
    </button>
  )
}

type PanelDef = { id: PanelId; tip: string; kbd?: string; icon: React.ReactNode }

const PANELS: PanelDef[] = [
  { id: 'tools', tip: 'Tools', kbd: 'T', icon: <I.Tools /> },
  { id: 'adjust', tip: 'Adjust', kbd: 'C', icon: <I.Adjust /> },
  { id: 'export', tip: 'Export', kbd: '⌘E', icon: <I.Export /> },
  { id: 'info', tip: 'Info', kbd: '⌘I', icon: <I.Info /> },
]
// A setting: the presets as a panel in the right sidebar. P opens it when the strip is off.
const PRESETS_PANEL: PanelDef = { id: 'presets', tip: 'Presets', icon: <I.PresetsPanel /> }

/** Opens a side panel; the open one is marked with a bar and closes the panel when clicked again. */
function PanelButton({ id, tip, kbd, disabled, children }: { id: PanelId; tip: string; kbd?: string; disabled?: boolean; children: React.ReactNode }) {
  const on = useLibrary((st) => st.panel === id && panelShown(st))
  const setPanel = useLibrary((st) => st.setPanel)
  const setSidebar = useLibrary((st) => st.setSidebar)
  return (
    <button
      className={`${s.btn} ${s.tab} ${on ? s.tabOn : ''}`}
      data-tip={tip}
      aria-label={tip}
      aria-pressed={on}
      disabled={disabled}
      {...tipOff}
      onClick={() => (on ? setSidebar(false) : setPanel(id))}
    >
      {children}
      <span className={s.tip}>
        {tip}
        {kbd && <kbd>{kbd}</kbd>}
      </span>
    </button>
  )
}

/** Shows or hides the preset strip under the photo or the grid; it stays up next to the other panels. */
function PresetsButton() {
  const open = useUi((u) => u.stripOpen)
  const on = useLibrary((st) => stripShown(open, st))
  const hasPhotos = useLibrary((st) => st.photos.length > 0)
  return (
    <button
      className={`${s.btn} ${on ? s.toggleOn : ''}`}
      data-tip="Preset strip"
      aria-label="Preset strip"
      aria-pressed={on}
      disabled={!hasPhotos}
      onClick={toggleStrip}
      {...tipOff}
    >
      <I.Presets />
      <span className={s.tip}>
        Preset strip
        <kbd>P</kbd>
      </span>
    </button>
  )
}

/** The logo goes home: the whole library in the grid, nothing selected, no side panel, no filter. The strip stays as it is. */
export function goHome() {
  const L = useLibrary.getState()
  if (L.panel === 'adjust') L.setPanel('none')
  if (L.gridSize >= 0.99) L.setGridSize(L.gridBack)
  L.clearSelection()
  L.setSidebar(false)
  const U = useUi.getState()
  U.setShortcuts(false)
  U.setFilter(NO_FILTER)
}

/** Back arrow and G: leave crop or the single view for the grid. Crop hands back to the presets. */
export function backToGrid() {
  const L = useLibrary.getState()
  if (L.panel === 'adjust') toggleStrip()
  if (L.gridSize >= 0.99) L.setGridSize(L.gridBack)
}

export function LeftRail() {
  const st = useLibrary()
  const hasSel = st.selected.length > 0
  const single = inSingleView(st)
  // Crop takes over the canvas: the rail keeps its edit actions but trades Add and the grid slider for a way back.
  const crop = inCrop(st)
  const shortcuts = useUi((u) => u.shortcuts)
  const setShortcuts = useUi((u) => u.setShortcuts)
  const strip = useSettings((x) => x.presetsStrip)
  const presetsPanel = useSettings((x) => x.presetsPanel)
  const panels = presetsPanel ? [{ ...PRESETS_PANEL, kbd: strip ? undefined : 'P' }, ...PANELS] : PANELS
  return (
    <nav className={s.rail} aria-label="Library">
      <button className={s.logo} aria-label="Home" title="Imaginary" onClick={goHome}>
        <I.Logo />
      </button>
      <div className={s.group}>
        {single || crop ? (
          <RailButton tip="Back to grid" kbd="G" onClick={backToGrid}>
            <I.Back />
          </RailButton>
        ) : (
          <RailButton tip="Add images" kbd="⌘O" onClick={openFilePicker}>
            <I.Add />
          </RailButton>
        )}
      </div>
      <div className={s.divider} />
      <div className={s.group} aria-label="Panels">
        {strip && <PresetsButton />}
        <FilterButton />
        {panels.map((p) => (
          <PanelButton key={p.id} id={p.id} tip={p.tip} kbd={p.kbd} disabled={!hasSel}>
            {p.icon}
          </PanelButton>
        ))}
      </div>
      <div className={s.spacer} />
      <div className={s.group} aria-label="History">
        <RailButton tip="Undo" kbd="⌘Z" onClick={st.undo} disabled={!st.past.length}>
          <I.Undo />
        </RailButton>
        <RailButton tip="Redo" kbd="⇧⌘Z" onClick={st.redo} disabled={!st.future.length}>
          <I.Redo />
        </RailButton>
      </div>
      <div className={s.divider} />
      {!crop && (
        <>
          <GridSizer />
          {single && <ZoomMenu />}
          <div className={s.divider} />
        </>
      )}
      <SettingsButton />
      <RailButton tip="Keyboard shortcuts" kbd="?" pressed={shortcuts} onClick={() => setShortcuts(!shortcuts)}>
        <I.Keyboard />
      </RailButton>
    </nav>
  )
}

// In single view the rail slider zooms (log scale over the menu range).
const zoomToT = (z: number) => Math.log(z / ZOOM_MIN) / Math.log(ZOOM_MAX / ZOOM_MIN)
const tToZoom = (t: number) => ZOOM_MIN * Math.pow(ZOOM_MAX / ZOOM_MIN, t)

function GridSizer() {
  const gridSize = useLibrary((st) => st.gridSize)
  const setGridSize = useLibrary((st) => st.setGridSize)
  const single = useLibrary(inSingleView)
  const zoom = useUi((u) => zoomScale(u))
  const setZoom = useUi((u) => u.setZoom)
  // Slider position -1..1 for either grid size or zoom.
  const size = single ? zoomToT(zoom) * 2 - 1 : gridSize
  const set = (v: number) => {
    if (!single) return setGridSize(v)
    setZoom(tToZoom((Math.max(-1, Math.min(1, v)) + 1) / 2))
  }
  const ref = useRef<HTMLDivElement>(null)
  const fromEvent = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const t = 1 - (e.clientY - r.top) / r.height
    set(t * 2 - 1)
  }
  const top = ((1 - (size + 1) / 2) * 100).toFixed(2) + '%'
  return (
    <div className={`${s.sizer} ${single ? s.sizerZoom : ''}`}>
      {!single && (
        <button className={c.iconButton} aria-label="Single image" onClick={() => setGridSize(1)}>
          <I.Single />
        </button>
      )}
      <div
        ref={ref}
        className={s.vrange}
        role="slider"
        aria-label={single ? 'Zoom' : 'Grid size'}
        aria-valuemin={-1}
        aria-valuemax={1}
        aria-valuenow={size}
        tabIndex={0}
        onPointerDown={(e) => {
          ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
          fromEvent(e)
        }}
        onPointerMove={(e) => e.buttons & 1 && fromEvent(e)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') set(size + 0.1)
          if (e.key === 'ArrowDown') set(size - 0.1)
          e.stopPropagation()
        }}
      >
        <div className={s.vthumb} style={{ top }} />
      </div>
      {!single && (
        <button className={c.iconButton} aria-label="Grid" onClick={() => setGridSize(-1)}>
          <I.Grid />
        </button>
      )}
    </div>
  )
}

/** Zoom level menu under the rail slider in single view. */
function ZoomMenu() {
  const zoom = useUi((u) => u.zoom)
  const setZoom = useUi((u) => u.setZoom)
  const setZoomAt = useUi((u) => u.setZoomAt)
  const [open, setOpen] = useState(false)
  const pick = (z: 'fit' | number) => {
    setZoom(z)
    if (z === 'fit') setZoomAt(null)
    setOpen(false)
  }
  return (
    <div className={s.zoomMenu}>
      <button className={s.zoomLabel} aria-label="Zoom level" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{zoomLabel(zoom)}</span>
        <I.Chevron />
      </button>
      {open && (
        <div className={s.zoomList} role="menu">
          {(['fit', ...ZOOM_LEVELS] as const).map((z) => (
            <button key={z} role="menuitem" className={`${c.menuItem} ${z === zoom ? s.zoomOn : ''}`} onClick={() => pick(z)}>
              {zoomLabel(z)}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
