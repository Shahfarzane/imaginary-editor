import { create } from 'zustand'
import { cloneEdit, defaultEdit, pasteEdit, type Edit } from '../model/edit'
import {
  deletePhotos,
  flushPhotos,
  getBlob,
  loadAll,
  onPhotosChanged,
  putBlob,
  putPhoto,
  putPhotoLater,
  type PhotoRecord,
} from './db'
import type { PhotoInfo } from '../model/photoInfo'
import { readInfo } from './exif'
import { RAW_EXTENSIONS } from '../engine/rawFormat'

const IMAGE_NAME = new RegExp(`\\.(jpe?g|png|webp|avif|heic|heif|gif|bmp|tiff?|${RAW_EXTENSIONS.join('|')})$`, 'i')
import {
  decodeBlob,
  drawable,
  forgetPhoto,
  loadPersistedThumb,
  requestThumb,
  setEditGetter,
  THUMB_EDGE,
} from './render'

/** The right sidebar's panel; 'none' leaves it empty (the strip and the photo carry the presets). */
export type PanelId = 'none' | 'presets' | 'tools' | 'adjust' | 'export' | 'info'

export interface Photo {
  id: string
  name: string
  width: number
  height: number
  added: number
  order: number
  edit: Edit
  favorite?: boolean
  /** Camera and file facts, read from the original once (undefined until then). */
  info?: PhotoInfo
}

interface HistoryEntry {
  label: string
  ids: string[]
  before: Edit[]
  after: Edit[]
}

interface Toast {
  id: number
  text: string
}

interface LibraryState {
  ready: boolean
  photos: Photo[]
  selected: string[]
  focus: string | null
  isolate: boolean
  gridSize: number // -1 (small grid) .. 1 (single image)
  gridBack: number // grid size to return to from the single view
  panel: PanelId
  /** The side panel is open; it still hides while nothing is selected (see panelShown). */
  sidebar: boolean
  showOriginal: boolean
  clipboard: Edit | null
  past: HistoryEntry[]
  future: HistoryEntry[]
  importing: number
  toasts: Toast[]
  /** Open transaction for slider drags: edits before the drag started. */
  txn: { label: string; ids: string[]; before: Edit[] } | null

  init: () => Promise<void>
  addFiles: (files: File[]) => Promise<void>
  select: (id: string, mode?: 'replace' | 'toggle' | 'range') => void
  selectAll: () => void
  clearSelection: () => void
  setGridSize: (v: number) => void
  /** Opens a panel, showing the side panel if it was hidden. */
  setPanel: (p: PanelId) => void
  setSidebar: (v: boolean) => void
  toggleIsolate: () => void
  setShowOriginal: (v: boolean) => void

  /** Live update of the selection's edits. Wrap drags in begin/commit. */
  updateEdits: (fn: (e: Edit, id: string) => Edit, label?: string) => void
  begin: (label: string) => void
  commit: () => void
  undo: () => void
  redo: () => void
  /** Jump to a point in history: index = number of applied steps. */
  jumpTo: (index: number) => void
  copy: () => void
  paste: () => void
  removeSelected: () => void
  /** Favorite the selection, or unfavorite it when every photo in it already is. */
  toggleFavorite: () => void
  /** Reads a photo's camera and file facts from its original if that has not happened yet. */
  ensureInfo: (id: string) => Promise<void>
  toast: (text: string) => void
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const record = (p: Photo): PhotoRecord => ({ ...p })

export const useLibrary = create<LibraryState>((set, get) => {
  const editOf = (id: string) => get().photos.find((p) => p.id === id)?.edit
  setEditGetter(editOf)
  const fromRecord = (r: PhotoRecord): Photo => {
    const d = defaultEdit(r.edit.seed)
    return {
      ...r,
      edit: {
        ...d,
        ...r.edit,
        tools: { ...d.tools, ...r.edit.tools },
        fx: { ...d.fx, ...r.edit.fx },
        bw: r.edit.bw ?? d.bw,
      },
    }
  }
  onPhotosChanged((records) => {
    const state = get()
    if (!state.ready) return
    const previous = new Map(state.photos.map((p) => [p.id, p]))
    const photos = records.map((r) => {
      const p = fromRecord(r),
        old = previous.get(p.id)
      // A favorite or another photo's save must not invalidate this photo's GPU render.
      return old && JSON.stringify(old.edit) === JSON.stringify(p.edit) ? { ...p, edit: old.edit } : p
    })
    const next = new Map(photos.map((p) => [p.id, p]))
    const changed = new Set(
      state.photos
        .filter((p) => !next.has(p.id) || JSON.stringify(p.edit) !== JSON.stringify(next.get(p.id)!.edit))
        .map((p) => p.id),
    )
    const externalEdit = state.photos.some((p) => changed.has(p.id) && next.has(p.id))
    set({
      photos,
      selected: state.selected.filter((id) => next.has(id)),
      focus: state.focus && next.has(state.focus) ? state.focus : (photos[0]?.id ?? null),
      past: state.past.filter((h) => !h.ids.some((id) => changed.has(id))),
      future: state.future.filter((h) => !h.ids.some((id) => changed.has(id))),
      txn: state.txn?.ids.some((id) => changed.has(id)) ? null : state.txn,
    })
    for (const p of state.photos) if (!next.has(p.id)) forgetPhoto(p.id)
    for (const p of photos) if (changed.has(p.id) || !state.photos.some((old) => old.id === p.id)) requestThumb(p.id)
    if (externalEdit) get().toast('Updated from another tab. Undo history for the changed photo was cleared.')
  })

  const applyEdits = (ids: string[], edits: Edit[]) => {
    const map = new Map(ids.map((id, i) => [id, edits[i]]))
    set({ photos: get().photos.map((p) => (map.has(p.id) ? { ...p, edit: map.get(p.id)! } : p)) })
    for (const p of get().photos) if (map.has(p.id)) putPhotoLater(record(p))
    ids.forEach(requestThumb)
  }

  return {
    ready: false,
    photos: [],
    selected: [],
    focus: null,
    isolate: false,
    gridSize: 0,
    gridBack: 0,
    panel: 'none',
    sidebar: loadSidebar(),
    showOriginal: false,
    clipboard: null,
    past: [],
    future: [],
    importing: 0,
    toasts: [],
    txn: null,

    async init() {
      const recs = await loadAll()
      // Merge onto current defaults so edits saved by older versions gain new tools.
      const photos = recs.map(fromRecord)
      set({ photos, ready: true, focus: photos[0]?.id ?? null })
      for (const p of photos) {
        void loadPersistedThumb(p.id).then((ok) => !ok && requestThumb(p.id))
      }
    },

    async addFiles(files) {
      const images = files.filter((f) => f.type.startsWith('image/') || IMAGE_NAME.test(f.name))
      if (!images.length) return
      set({ importing: get().importing + images.length })
      let order = get().photos.reduce((m, p) => Math.max(m, p.order), 0)
      const added: string[] = []
      for (const file of images) {
        let decoded = false
        try {
          const bmp = await decodeBlob(file)
          decoded = true
          const id = uid()
          const [w, h] = [bmp.width, bmp.height]
          const scale = Math.min(1, THUMB_EDGE / Math.max(w, h))
          const tw = Math.max(1, Math.round(w * scale))
          const th = Math.max(1, Math.round(h * scale))
          const c = new OffscreenCanvas(tw, th)
          const ctx = c.getContext('2d')!
          ctx.imageSmoothingQuality = 'high'
          const view = await drawable(bmp, THUMB_EDGE)
          ctx.drawImage(view, 0, 0, tw, th)
          if (view !== bmp) view.close()
          bmp.close()
          const thumbBlob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
          await putBlob('originals', id, file)
          await putBlob('thumbSources', id, thumbBlob)
          const photo: Photo = {
            id,
            name: file.name,
            width: w,
            height: h,
            added: Date.now(),
            order: ++order,
            edit: defaultEdit(),
          }
          await putPhoto(record(photo))
          set({ photos: [...get().photos.filter((p) => p.id !== id), photo] })
          added.push(id)
          requestThumb(id)
          // Camera facts in the background; the file is still in hand. A failed read is retried when Info opens.
          void readInfo(file, file.name).then(
            (info) => {
              set({ photos: get().photos.map((x) => (x.id === id ? { ...x, info } : x)) })
              const now = get().photos.find((x) => x.id === id)
              if (now) putPhotoLater(record(now))
            },
            (e) => console.error(e),
          )
        } catch (e) {
          console.error(e)
          get().toast(
            decoded
              ? `Could not keep ${file.name} in this browser's storage (${(e as Error).message}).`
              : `Could not open ${file.name}. This browser may not decode that format.`,
          )
        } finally {
          set({ importing: get().importing - 1 })
        }
      }
      if (added.length) set({ selected: added, focus: added[added.length - 1] })
    },

    select(id, mode = 'replace') {
      const { selected, photos, focus } = get()
      if (mode === 'toggle') {
        const has = selected.includes(id)
        set({ selected: has ? selected.filter((s) => s !== id) : [...selected, id], focus: id })
      } else if (mode === 'range' && focus) {
        const a = photos.findIndex((p) => p.id === focus)
        const b = photos.findIndex((p) => p.id === id)
        const [lo, hi] = a < b ? [a, b] : [b, a]
        set({ selected: [...new Set([...selected, ...photos.slice(lo, hi + 1).map((p) => p.id)])], focus: id })
      } else {
        set({ selected: [id], focus: id })
      }
    },
    selectAll: () => set({ selected: get().photos.map((p) => p.id) }),
    clearSelection: () => set({ selected: [], isolate: false }),
    setGridSize: (v) => {
      const gridSize = Math.max(-1, Math.min(1, v))
      set(gridSize < 0.99 ? { gridSize, gridBack: gridSize } : { gridSize })
    },
    setPanel: (panel) => {
      saveSidebar(true)
      set({ panel, sidebar: true })
    },
    setSidebar: (sidebar) => {
      saveSidebar(sidebar)
      set({ sidebar })
    },
    toggleIsolate: () => set({ isolate: !get().isolate && get().selected.length > 0 }),
    setShowOriginal: (v) => set({ showOriginal: v }),

    updateEdits(fn, label = 'Edit') {
      const { selected, txn } = get()
      if (!selected.length) return
      const before = selected.map((id) => editOf(id)!).filter(Boolean)
      const after = selected.map((id, i) => fn(cloneEdit(before[i]), id))
      applyEdits(selected, after)
      if (!txn) {
        set({ past: [...get().past.slice(-199), { label, ids: selected, before, after }], future: [] })
      }
    },
    begin(label) {
      const { selected } = get()
      if (!selected.length || get().txn) return
      set({ txn: { label, ids: selected, before: selected.map((id) => cloneEdit(editOf(id)!)) } })
    },
    commit() {
      const t = get().txn
      if (!t) return
      const after = t.ids.map((id) => cloneEdit(editOf(id)!))
      const changed = JSON.stringify(after) !== JSON.stringify(t.before)
      set({
        txn: null,
        ...(changed ? { past: [...get().past.slice(-199), { ...t, after }], future: [] } : {}),
      })
      // A finished drag is written now, not after the delay.
      if (changed) void flushPhotos()
    },
    undo() {
      const e = get().past.at(-1)
      if (!e) return
      applyEdits(e.ids, e.before)
      set({ past: get().past.slice(0, -1), future: [...get().future, e] })
    },
    redo() {
      const e = get().future.at(-1)
      if (!e) return
      applyEdits(e.ids, e.after)
      set({ future: get().future.slice(0, -1), past: [...get().past, e] })
    },
    jumpTo(index) {
      const total = get().past.length + get().future.length
      const target = Math.max(0, Math.min(total, Math.round(index)))
      while (get().past.length > target) get().undo()
      while (get().past.length < target) get().redo()
    },
    copy() {
      const id = get().focus && get().selected.includes(get().focus!) ? get().focus : get().selected[0]
      const e = id ? editOf(id) : undefined
      if (e) {
        set({ clipboard: cloneEdit(e) })
        get().toast('Edits copied')
      }
    },
    paste() {
      const c = get().clipboard
      if (!c) return
      get().updateEdits((e) => pasteEdit(e, c), 'Paste edits')
    },
    removeSelected() {
      const ids = get().selected
      if (!ids.length) return
      ids.forEach(forgetPhoto)
      deletePhotos(ids).catch((e) => {
        console.error(e)
        get().toast('Could not remove the photos from browser storage; they may come back after a reload.')
      })
      const photos = get().photos.filter((p) => !ids.includes(p.id))
      set({
        photos,
        selected: [],
        txn: null,
        isolate: false,
        focus: photos[0]?.id ?? null,
        past: get().past.filter((h) => !h.ids.some((i) => ids.includes(i))),
        future: [],
      })
    },
    toggleFavorite() {
      const ids = new Set(get().selected)
      if (!ids.size) return
      const all = get()
        .photos.filter((p) => ids.has(p.id))
        .every((p) => p.favorite)
      set({ photos: get().photos.map((p) => (ids.has(p.id) ? { ...p, favorite: !all } : p)) })
      for (const p of get().photos) if (ids.has(p.id)) putPhotoLater(record(p))
    },
    async ensureInfo(id) {
      const p = get().photos.find((x) => x.id === id)
      if (!p || p.info) return
      const blob = await getBlob('originals', id)
      if (!blob) return
      const info = await readInfo(blob, p.name)
      set({ photos: get().photos.map((x) => (x.id === id ? { ...x, info } : x)) })
      const now = get().photos.find((x) => x.id === id)
      if (now) putPhotoLater(record(now))
    },
    toast(text) {
      const id = Date.now() + Math.random()
      set({ toasts: [...get().toasts, { id, text }] })
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 2600)
    },
  }
})

/** The side panel shows while it is open, a panel is chosen and there is something to edit. */
export const panelShown = (s: LibraryState) => s.sidebar && s.selected.length > 0 && s.panel !== 'none'

const SIDEBAR_KEY = 'studio.sidebar'
function loadSidebar() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) !== '0'
  } catch {
    return true
  }
}
function saveSidebar(v: boolean) {
  try {
    localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0')
  } catch {
    /* private mode: the choice lasts for this session */
  }
}

/** The photo the right panel edits and the single view shows. */
export function activePhoto(s: LibraryState): Photo | null {
  const id = s.focus && s.selected.includes(s.focus) ? s.focus : s.selected[0]
  return s.photos.find((p) => p.id === id) ?? null
}

/** True when one photo fills the view (the zoomable single view, not crop). */
export const inSingleView = (s: LibraryState) => s.gridSize >= 0.99 && s.panel !== 'adjust' && !!activePhoto(s)

/** True while crop takes over the canvas. */
export const inCrop = (s: LibraryState) => s.panel === 'adjust' && !!activePhoto(s)
