import { useEffect, useMemo } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Autocomplete } from '@base-ui/react/autocomplete'
import s from './CommandPalette.module.css'
import * as I from './icons'
import { inCrop, inSingleView, panelShown, useLibrary, type PanelId } from '../store/library'
import { useUi } from './uiState'
import { useSettings } from './settings'
import { openFilePicker } from './DropZone'
import { backToGrid, goHome } from './LeftRail'
import { toggleStrip } from './PresetStrip'
import { applyPreset } from './presetActions'
import { pasteEdit } from '../model/edit'
import { familyOf, getPreset } from '../model/presets'
import { PRESET_COLORS } from '../model/presetColors'
import { tileByCode } from '../model/presetOrder'
import { useCollections } from '../store/collections'
import { orderedGroups, useStripOrder } from '../store/stripOrder'
import { useUserPresets } from '../store/userPresets'
import { pillFill } from './colorui'
import { CREDIT } from './credit'

interface Command {
  value: string
  label: string
  /** The shortcut, or a short note, on the right. */
  hint?: string
  /** More words to match, besides the label. */
  keywords?: string
  /** A preset's code chip. */
  chip?: { text: string; style: React.CSSProperties }
  /** Listed only once something is typed (the presets). */
  searchOnly?: boolean
  run: () => void
}
interface Group {
  value: string
  items: Command[]
}

/** Every word of the query appears in the label or the keywords; with no query, everything but the presets. */
function filter(item: Command, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return !item.searchOnly
  const hay = `${item.label} ${item.keywords ?? ''}`.toLowerCase()
  return q.split(/\s+/).every((w) => hay.includes(w))
}

/** The commands that apply right now, built when the palette opens. */
function useCommands(open: boolean): Group[] {
  const collections = useCollections((c) => c.list)
  const groupOrder = useStripOrder((o) => o.groups)
  const setOrders = useStripOrder((o) => o.sets)
  const saved = useUserPresets((u) => u.list)
  const load = useUserPresets((u) => u.load)
  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return useMemo(() => {
    if (!open) return []
    const L = useLibrary.getState()
    const U = useUi.getState()
    const S = useSettings.getState()
    const hasPhotos = L.photos.length > 0
    const hasSel = L.selected.length > 0
    const single = inSingleView(L)
    const panel = (id: PanelId) => () => L.setPanel(id)
    const when = (ok: boolean, c: Command) => (ok ? [c] : [])

    const photos: Command[] = [
      { value: 'add', label: 'Add images', hint: '⌘O', keywords: 'import open files', run: openFilePicker },
      ...when(hasPhotos, { value: 'select-all', label: 'Select all', hint: '⌘A', run: L.selectAll }),
      ...when(hasSel, { value: 'deselect', label: 'Clear selection', keywords: 'deselect none', run: L.clearSelection }),
      ...when(hasSel, { value: 'favorite', label: 'Favorite', hint: '.', keywords: 'heart like', run: L.toggleFavorite }),
      ...when(hasSel, { value: 'isolate', label: L.isolate ? 'Show all photos' : 'Isolate selection', hint: 'I', run: L.toggleIsolate }),
      ...when(hasSel, { value: 'copy', label: 'Copy edit', hint: '⌘C', run: L.copy }),
      ...when(hasSel && !!L.clipboard, { value: 'paste', label: 'Paste edit', hint: '⌘V', run: L.paste }),
      ...when(hasSel, { value: 'unedited', label: 'Remove preset', keywords: 'unedited original none clear look', run: () => applyPreset(null) }),
      ...when(L.past.length > 0, { value: 'undo', label: 'Undo', hint: '⌘Z', run: L.undo }),
      ...when(L.future.length > 0, { value: 'redo', label: 'Redo', hint: '⇧⌘Z', run: L.redo }),
    ]

    const view: Command[] = [
      { value: 'home', label: 'Go home', keywords: 'library all photos logo', run: goHome },
      ...when(hasPhotos && (single || inCrop(L)), { value: 'grid', label: 'Back to grid', hint: 'G', run: backToGrid }),
      ...when(hasSel && !single && !inCrop(L), { value: 'single', label: 'Single view', hint: 'G', keywords: 'open photo large', run: () => L.setGridSize(1) }),
      ...when(single, { value: 'zoom', label: U.zoom === 'fit' ? 'Zoom to 100%' : 'Zoom to fit', hint: 'Z', run: () => (U.setZoomAt(null), U.setZoom(U.zoom === 'fit' ? 1 : 'fit')) }),
      ...when(single, { value: 'split', label: U.split === null ? 'Before and after' : 'Hide before and after', hint: 'B', keywords: 'compare split original', run: () => U.setSplit(U.split === null ? 0.5 : null) }),
      ...when(S.presetsStrip && hasPhotos, { value: 'strip', label: U.stripOpen ? 'Hide preset strip' : 'Show preset strip', hint: 'P', run: toggleStrip }),
    ]

    const panels: Command[] = hasSel
      ? [
          ...when(S.presetsPanel, { value: 'p-presets', label: 'Presets', hint: S.presetsStrip ? undefined : 'P', keywords: 'panel looks list', run: panel('presets') }),
          { value: 'p-tools', label: 'Tools', hint: 'T', keywords: 'panel adjust edit sliders exposure color', run: panel('tools') },
          { value: 'p-crop', label: 'Crop', hint: 'C', keywords: 'panel rotate straighten aspect', run: panel('adjust') },
          { value: 'p-export', label: 'Export', hint: '⌘E', keywords: 'panel save download', run: panel('export') },
          { value: 'p-info', label: 'Info', hint: '⌘I', keywords: 'panel camera details exif', run: panel('info') },
          ...when(panelShown(L), { value: 'p-hide', label: 'Hide panel', hint: '⌘B', keywords: 'close sidebar', run: () => L.setSidebar(false) }),
        ]
      : []

    const settings: Command[] = [
      ...when(!(S.presetsStrip && !S.presetsPanel), {
        value: 's-strip',
        label: S.presetsStrip ? 'Turn off the preset strip' : 'Turn on the preset strip',
        keywords: 'settings',
        run: () => S.setPresetsStrip(!S.presetsStrip),
      }),
      ...when(!(S.presetsPanel && !S.presetsStrip), {
        value: 's-panel',
        label: S.presetsPanel ? 'Turn off the Presets panel' : 'Turn on the Presets panel',
        keywords: 'settings sidebar',
        run: () => S.setPresetsPanel(!S.presetsPanel),
      }),
      { value: 's-keys', label: 'Keyboard shortcuts', hint: '?', keywords: 'help keys', run: () => U.setShortcuts(true) },
    ]

    // Presets apply to the selection; they are listed once something is typed.
    const presets: Command[] = []
    if (hasSel) {
      saved.forEach((r, i) =>
        presets.push({
          value: `u-${r.id}`,
          label: r.name,
          keywords: `U${i + 1} your preset`,
          chip: { text: `U${i + 1}`, style: {} },
          searchOnly: true,
          run: () => L.updateEdits((e) => pasteEdit(e, r.edit), `Preset ${r.name}`),
        }),
      )
      const seen = new Set<string>()
      for (const g of orderedGroups(collections, { groups: groupOrder, sets: setOrders })) {
        for (const code of g.codes) {
          if (seen.has(code)) continue
          seen.add(code)
          const tile = tileByCode(code)
          const preset = tile && getPreset(tile.look)
          if (!tile || !preset) continue
          const color = PRESET_COLORS[preset.code] ?? familyOf(preset).color
          const stock = familyOf(preset).chip === 'stock'
          presets.push({
            value: `t-${code}`,
            label: tile.name,
            keywords: `${code} ${tile.full} ${g.collection?.name ?? g.key} preset look`,
            chip: { text: code, style: stock ? { background: '#fff', color } : { background: pillFill(color), color: '#fff' } },
            searchOnly: true,
            run: () => applyPreset(tile),
          })
        }
      }
    }

    const about: Command[] = [
      {
        value: 'credit',
        label: `Made by ${CREDIT.name}`,
        hint: 'nerd.ceo',
        keywords: 'about credits author homepage',
        run: () => window.open(CREDIT.url, '_blank', 'noopener'),
      },
    ]

    return [
      { value: 'Photos', items: photos },
      { value: 'View', items: view },
      { value: 'Panels', items: panels },
      { value: 'Presets', items: presets },
      { value: 'Settings', items: settings },
      { value: 'About', items: about },
    ].filter((g) => g.items.length > 0)
  }, [open, saved, collections, groupOrder, setOrders])
}

/** Cmd+K: search the app's commands and the presets, Enter runs the highlighted one. */
export function CommandPalette() {
  const open = useUi((u) => u.palette)
  const setOpen = useUi((u) => u.setPalette)
  const groups = useCommands(open)

  const run = (c: Command) => {
    // Runs inside the click or Enter, so file pickers and new tabs count as user actions.
    c.run()
    setOpen(false)
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className={s.backdrop} />
        <Dialog.Viewport className={s.viewport}>
          <Dialog.Popup className={s.popup} aria-label="Command palette">
            <Autocomplete.Root open inline items={groups} filter={filter} autoHighlight="always" keepHighlight>
              <Autocomplete.InputGroup className={s.inputGroup}>
                <I.Search />
                <Autocomplete.Input className={s.input} aria-label="Search commands and presets" placeholder="Search commands and presets…" />
              </Autocomplete.InputGroup>
              <Dialog.Close className={s.hidden}>Close command palette</Dialog.Close>
              <div className={s.list}>
                <Autocomplete.Empty>
                  <div className={s.empty}>Nothing matches.</div>
                </Autocomplete.Empty>
                <Autocomplete.List>
                  {(group: Group) => (
                    <Autocomplete.Group key={group.value} items={group.items} className={s.group}>
                      <Autocomplete.GroupLabel className={s.groupLabel}>{group.value}</Autocomplete.GroupLabel>
                      <Autocomplete.Collection>
                        {(item: Command) => (
                          <Autocomplete.Item key={item.value} value={item} className={s.item} onClick={() => run(item)}>
                            {item.chip && (
                              <span className={s.chip} style={item.chip.style}>
                                {item.chip.text}
                              </span>
                            )}
                            <span className={s.label}>{item.label}</span>
                            {item.hint && <span className={s.hint}>{item.hint}</span>}
                          </Autocomplete.Item>
                        )}
                      </Autocomplete.Collection>
                    </Autocomplete.Group>
                  )}
                </Autocomplete.List>
              </div>
              <div className={s.footer}>
                <span className={s.keys}>
                  <kbd className={s.key}>↵</kbd> run <kbd className={s.key}>esc</kbd> close
                </span>
                <a className={s.credit} href={CREDIT.url} target="_blank" rel="noopener">
                  Made by {CREDIT.name}
                </a>
              </div>
            </Autocomplete.Root>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
