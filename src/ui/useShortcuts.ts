import { useEffect } from 'react'
import { inCrop, inSingleView, useLibrary, panelShown } from '../store/library'
import { stepZoom, useUi } from './uiState'
import { useSettings } from './settings'
import { openFilePicker } from './DropZone'
import { stepPreset, toggleStrip } from './PresetStrip'
import { backToGrid } from './LeftRail'
import { visiblePhotos } from './visible'

export const SHORTCUTS: [string, string][] = [
  ['\\ (hold)', 'Show original'],
  ['B', 'Before / after split'],
  ['Z', 'Zoom to 100% / fit'],
  ['+  -', 'Zoom in, out'],
  ['1', 'Fit to screen'],
  ['P', 'Preset strip, or the Presets panel when the strip is off'],
  ['T  C', 'Tools, Adjust (crop)'],
  ['⌘E', 'Export'],
  ['⌘B', 'Show or hide the panel'],
  ['⌘O', 'Add images'],
  ['⌘Z  ⇧⌘Z', 'Undo, redo'],
  ['⌘C  ⌘V', 'Copy and paste edits'],
  ['⌘A', 'Select all'],
  ['← →', 'Previous, next photo; in the single view, previous, next preset'],
  ['↑ ↓', 'Previous, next photo in the single view'],
  ['⌘-click a preset', 'Pick it for a collection'],
  ['I', 'Isolate selection'],
  ['.', 'Favorite'],
  ['⌘I', 'Info'],
  ['G', 'Toggle grid / single view'],
  ['⌫', 'Delete selection'],
  ['R', 'Reroll grain, dust and light-leak seed'],
  ['⌘K', 'Command palette'],
  ['?', 'This list'],
  ['Esc', 'Close, deselect'],
]

export function useShortcuts() {
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      // Cmd+K opens and closes the command palette from anywhere, a text field included.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useUi.getState().setPalette(!useUi.getState().palette)
        return
      }
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      const L = useLibrary.getState()
      const U = useUi.getState()
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()

      if (e.key === '\\') {
        if (!e.repeat) L.setShowOriginal(true)
        e.preventDefault()
        return
      }
      if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) L.redo()
        else L.undo()
        return
      }
      if (mod && k === 'y') {
        e.preventDefault()
        L.redo()
        return
      }
      if (mod && k === 'c') {
        e.preventDefault()
        L.copy()
        return
      }
      if (mod && k === 'v') {
        // Let image pastes through to the import handler.
        if (L.clipboard) {
          e.preventDefault()
          L.paste()
        }
        return
      }
      if (mod && k === 'i') {
        e.preventDefault()
        L.setPanel('info')
        return
      }
      if (mod && k === 'a') {
        e.preventDefault()
        L.selectAll()
        return
      }
      if (mod && k === 'o') {
        e.preventDefault()
        openFilePicker()
        return
      }
      if (mod && k === 'b') {
        e.preventDefault()
        L.setSidebar(!L.sidebar)
        return
      }
      if (mod && k === 'e') {
        e.preventDefault()
        L.setPanel('export')
        U.setExportOpen(true)
        return
      }
      // The browser zoom keys zoom the photo in the single view.
      if (mod && inSingleView(L) && ['=', '+', '-', '_', '0'].includes(e.key)) {
        e.preventDefault()
        if (e.key === '0') {
          U.setZoom('fit')
          U.setZoomAt(null)
        } else stepZoom(e.key === '-' || e.key === '_' ? -1 : 1)
        return
      }
      if (mod) return

      switch (e.key) {
        case 'Escape':
          if (U.shortcuts) U.setShortcuts(false)
          else if (U.exportOpen) U.setExportOpen(false)
          else if (U.zoom !== 'fit') {
            U.setZoom('fit')
            U.setZoomAt(null)
          }
          else if (L.panel === 'adjust') L.setPanel('tools')
          else if (L.gridSize >= 0.99) L.setGridSize(L.gridBack)
          else L.clearSelection()
          break
        case 'Backspace':
        case 'Delete':
          L.removeSelected()
          break
        case '?':
          U.setShortcuts(!U.shortcuts)
          break
        case '.':
          L.toggleFavorite()
          break
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          const single = inSingleView(L)
          const horizontal = e.key === 'ArrowLeft' || e.key === 'ArrowRight'
          // The single view steps through the presets sideways, like the strip, and through the photos up and down.
          if (single && horizontal) {
            stepPreset(e.key === 'ArrowRight' ? 1 : -1)
            e.preventDefault()
            break
          }
          // Up and down in the grid scroll it.
          if (!single && !horizontal) break
          const vis = visiblePhotos(L.photos, L.selected, L.isolate, U.filter)
          if (!vis.length) break
          const i = vis.findIndex((p) => p.id === L.focus)
          const n = vis[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1) + vis.length) % vis.length]
          if (L.isolate) useLibrary.setState({ focus: n.id })
          else L.select(n.id)
          e.preventDefault()
          break
        }
        default:
          switch (k) {
            case 'p':
              // The strip, or the Presets panel when the strip is off (settings).
              if (useSettings.getState().presetsStrip) toggleStrip()
              else if (L.panel === 'presets' && panelShown(L)) L.setSidebar(false)
              else L.setPanel('presets')
              break
            case 't':
              L.setPanel('tools')
              break
            case 'c':
              L.setPanel('adjust')
              break
            // Effects used to be its own panel; F still lands on them.
            case 'f':
              L.setPanel('tools')
              break
            case 'i':
              L.toggleIsolate()
              break
            case 'g':
              if (inCrop(L) || L.gridSize >= 0.99) backToGrid()
              else L.setGridSize(1)
              break
            case 'b':
              U.setSplit(U.split === null ? 0.5 : null)
              break
            case 'z':
              if (L.gridSize < 0.99) L.setGridSize(1)
              U.setZoomAt(null)
              U.setZoom(U.zoom === 'fit' ? 1 : 'fit')
              break
            case '+':
            case '=':
              // Zoom works on the single view; in the grid it grows the tiles.
              if (inSingleView(L)) stepZoom(1)
              else L.setGridSize(Math.min(1, L.gridSize + 0.25))
              break
            case '-':
            case '_':
              if (inSingleView(L)) stepZoom(-1)
              else L.setGridSize(Math.max(-1, L.gridSize - 0.25))
              break
            case '1':
              U.setZoom('fit')
              U.setZoomAt(null)
              break
            case 'r':
              L.updateEdits((ed) => ({ ...ed, seed: Math.floor(Math.random() * 1e6) }), 'Reroll')
              break
          }
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === '\\') useLibrary.getState().setShowOriginal(false)
    }
    const blur = () => useLibrary.getState().setShowOriginal(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])
}
