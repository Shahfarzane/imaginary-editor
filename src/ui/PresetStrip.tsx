import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import s from './PresetStrip.module.css'
import * as I from './icons'
import { hasEdits, pasteEdit, type Edit } from '../model/edit'
import { familyOf, getPreset } from '../model/presets'
import { PRESET_COLORS } from '../model/presetColors'
import { STRIP, tileOf } from '../model/strip'
import { tileByCode } from '../model/presetOrder'
import { activePhoto, useLibrary, type Photo } from '../store/library'
import { presetEdit, useUserPresets } from '../store/userPresets'
import { useCollections, type Collection } from '../store/collections'
import { orderedGroups, useStripOrder, type StripGroup } from '../store/stripOrder'
import type { RecipeRecord } from '../store/db'
import { baseKey, cancelPreview, coverRect, previewEdit, previewOf, requestPreview, usePreviewTick } from '../store/presetPreviews'
import { usePreview } from './preview'
import { pillFill } from './colorui'
import { applyPreset, useCurrentTile } from './presetActions'
import { useUi } from './uiState'
import { NameEditor } from './NameEditor'
import { StripMenu, type MenuAt } from './StripMenu'
import { stripDrag, useStripDrag, type DragItem, type Drop } from './useStripDrag'

/** Height the views keep free under the photo or the grid for the strip: the strip and its margins. */
export const STRIP_BAND = 86

/** The strip shows while it is open and a photo is active, except in crop, which takes over the canvas. */
export const stripShown = (open: boolean, st: Parameters<typeof activePhoto>[0]) => open && st.panel !== 'adjust' && !!activePhoto(st)

/** Rail button and P: leaves crop for the strip, otherwise shows or hides it. */
export function toggleStrip() {
  const L = useLibrary.getState()
  const U = useUi.getState()
  if (L.panel === 'adjust') {
    L.setPanel('none')
    U.setStripOpen(true)
  } else U.setStripOpen(!U.stripOpen)
}

// The place the arrow keys last stepped to: a code that shows twice (in a collection and in its set) keeps its place.
let cursor = -1

/**
 * Arrow keys in the single view: the selection takes the previous or next preset in the strip's order, from no
 * preset before the first. The strip scrolls the tile into view.
 */
export function stepPreset(dir: -1 | 1) {
  const photo = activePhoto(useLibrary.getState())
  if (!photo) return
  const seq = orderedGroups(useCollections.getState().list, useStripOrder.getState()).flatMap((g) => g.codes)
  const code = tileOf(photo.edit.preset)?.code ?? null
  const at = code === null ? -1 : seq[cursor] === code ? cursor : seq.indexOf(code)
  const next = Math.max(-1, Math.min(seq.length - 1, at + dir))
  if (next === at) return
  cursor = next
  applyPreset(next < 0 ? null : tileByCode(seq[next])!)
  requestAnimationFrame(() =>
    document.querySelector(`[data-strip-pos="${next}"]`)?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }),
  )
}

/** A set's short label: its code prefix, on its color as the set's first tile shows it; the Studio set in gold. */
function setLabel(title: string): { text: string; style: React.CSSProperties } {
  const set = STRIP.find((x) => x.title === title)!
  if (set.tiles.every((t) => t.pro)) return { text: set.prefix, style: { background: '#edba58', color: '#1d1608' } }
  const preset = getPreset(set.tiles[0].look)!
  const color = PRESET_COLORS[preset.code] ?? familyOf(preset).color
  return familyOf(preset).chip === 'stock'
    ? { text: set.prefix, style: { background: '#fff', color } }
    : { text: set.prefix, style: { background: pillFill(color), color: '#fff' } }
}

/** What a name box is open for: a saved preset or a collection, new (id null) or existing. */
type Naming = { kind: 'preset' | 'collection'; id: string | null; name: string }

/**
 * The presets as a strip under the photo or the grid: a pinned tile that saves the edit as a preset, your saved
 * presets, then your collections and the catalog's sets in your order. Hover shows a preset on the photo and a click
 * applies it to the selection (or takes it off again). A right-click adds it to a collection, ⌘- or Shift-click picks
 * several, and dragging a tile or a group's label rearranges the strip.
 */
export function PresetStrip({ photo }: { photo: Photo }) {
  const scroller = useRef<HTMLDivElement>(null)
  const current = useCurrentTile()
  const collections = useCollections((c) => c.list)
  const groupOrder = useStripOrder((o) => o.groups)
  const setOrders = useStripOrder((o) => o.sets)
  const groups = useMemo(() => orderedGroups(collections, { groups: groupOrder, sets: setOrders }), [collections, groupOrder, setOrders])
  const base = baseKey(photo.edit)
  const [naming, setNaming] = useState<Naming | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const drag = useStripDrag(
    scroller,
    s.ghost,
    (item, d) => canDrop(groups, item, d),
    (item, d) => land(groups, item, d),
  )

  // A wheel turned over the strip scrolls it sideways.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  // The photo's preset in view when another photo opens.
  useEffect(() => {
    scroller.current?.querySelector('[aria-pressed="true"]')?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [photo.id])
  // Escape lets go of the picked presets before it does anything else.
  useEffect(() => {
    if (!picked.length) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setPicked([])
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [picked.length])

  const pick = (code: string) => setPicked((p) => (p.includes(code) ? p.filter((c) => c !== code) : [...p, code]))
  const openMenu = (e: React.MouseEvent, code: string) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, codes: picked.includes(code) && picked.length > 1 ? picked : [code] })
  }
  const dropClass = (key: string, code: string | null) => {
    const side = dropSide(drag.drop, key, code)
    return side === 'before' ? s.dropBefore : side === 'after' ? s.dropAfter : ''
  }
  let pos = 0

  return (
    <nav className={s.strip} aria-label="Preset strip">
      {picked.length > 0 && <PickBar picked={picked} onDone={() => setPicked([])} />}
      {menu && <StripMenu at={menu} onClose={closeMenu} onAction={() => setPicked([])} />}
      <div className={s.tray}>
        <SaveSlot photo={photo} naming={naming?.kind === 'preset' && !naming.id ? naming : null} onName={setNaming} />
        <div ref={scroller} className={s.scroller} data-strip-scroll>
          <SavedPresets photo={photo} base={base} naming={naming?.kind === 'preset' && naming.id ? naming : null} onName={setNaming} />
          {groups.map((g) => {
            const editing = !!g.collection && naming?.kind === 'collection' && naming.id === g.collection.id ? naming : null
            const lifted = drag.dragging?.kind === 'group' && drag.dragging.group === g.key
            return (
              <div
                key={g.key}
                className={`${s.group} ${lifted ? s.lifted : ''} ${dropClass(g.key, null)}`}
                role="group"
                aria-label={g.collection?.name ?? g.key}
                data-group={g.key}
              >
                {g.collection ? (
                  <CollectionLabel
                    collection={g.collection}
                    onEdit={() => setNaming({ kind: 'collection', id: g.collection!.id, name: g.collection!.name })}
                    onPointerDown={(e) => drag.start(e, { kind: 'group', group: g.key })}
                  />
                ) : (
                  <SetLabel title={g.key} onPointerDown={(e) => drag.start(e, { kind: 'group', group: g.key })} />
                )}
                {editing && (
                  <NameEditor
                    field="Collection name"
                    initial={editing.name}
                    saveLabel="Rename"
                    deleteLabel={g.collection!.name}
                    onSubmit={(name) => useCollections.getState().rename(g.collection!.id, name)}
                    onDelete={() => useCollections.getState().remove(g.collection!.id)}
                    onClose={() => setNaming(null)}
                  />
                )}
                {g.codes.map((code) => {
                  const tile = tileByCode(code)!
                  const selected = current === code
                  const at = pos++
                  const moving = drag.dragging?.kind === 'tile' && drag.dragging.code === code && drag.dragging.group === g.key
                  return (
                    <Thumb
                      key={code}
                      photo={photo}
                      base={base}
                      previewKey={tile.look}
                      edit={previewEdit(photo.edit, tile.look)}
                      selected={selected}
                      picked={picked.includes(code)}
                      extraClass={`${moving ? s.lifted : ''} ${dropClass(g.key, code)}`}
                      label={`preset ${tile.code}: ${tile.name}`}
                      title={`${tile.code} ${tile.full}\nRight-click for collections. Drag to move.`}
                      hoverLook={tile.look}
                      code={tile.code}
                      pos={at}
                      onPointerDown={(e) => drag.start(e, { kind: 'tile', code, group: g.key })}
                      onContextMenu={(e) => openMenu(e, code)}
                      onClick={(e) => {
                        if (drag.wasDragged()) return
                        if (e.metaKey || e.ctrlKey || e.shiftKey) return pick(code)
                        cursor = at
                        applyPreset(selected ? null : tile)
                      }}
                    />
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </nav>
  )
}

/** Which side of a tile (or, code null, of a group) the current drop lands on, if it lands there. */
function dropSide(d: Drop | null, key: string, code: string | null): 'before' | 'after' | null {
  if (!d || d.group !== key || d.code !== code) return null
  return d.after ? 'after' : 'before'
}

/**
 * Where a drag may land: a group next to another group; a tile inside its own group, or into a collection that
 * does not have it yet. A catalog set only ever holds its own presets.
 */
function canDrop(groups: StripGroup[], item: DragItem, d: Drop): boolean {
  if (item.kind === 'group') return d.code === null && d.group !== item.group
  if (d.group === item.group) return d.code !== null && d.code !== item.code
  const into = groups.find((g) => g.key === d.group)?.collection
  return !!into && !into.codes.includes(item.code)
}

function land(groups: StripGroup[], item: DragItem, d: Drop) {
  if (item.kind === 'group') {
    const keys = groups.map((g) => g.key)
    return useStripOrder.getState().moveGroup(keys, item.group, d.group, d.after)
  }
  const into = groups.find((g) => g.key === d.group)!
  if (into.collection) return useCollections.getState().place(into.collection.id, item.code, d.code, d.after)
  if (d.code) useStripOrder.getState().moveInSet(into.key, item.code, d.code, d.after)
}

function SetLabel({ title, onPointerDown }: { title: string; onPointerDown: (e: React.PointerEvent) => void }) {
  const label = setLabel(title)
  return (
    <div className={`${s.label} ${s.handle}`} style={label.style} title={`${title}. Drag to move the set.`} aria-hidden="true" onPointerDown={onPointerDown}>
      {label.text}
    </div>
  )
}

/** A collection's label: the first letters of its name; a double-click or a right-click renames or deletes it. */
function CollectionLabel({
  collection,
  onEdit,
  onPointerDown,
}: {
  collection: Collection
  onEdit: () => void
  onPointerDown: (e: React.PointerEvent) => void
}) {
  return (
    <button
      className={`${s.label} ${s.mine} ${s.handle}`}
      aria-label={`collection ${collection.name}`}
      title={`${collection.name}. Double-click to rename or delete; drag to move.`}
      onPointerDown={onPointerDown}
      onDoubleClick={onEdit}
      onContextMenu={(e) => {
        e.preventDefault()
        onEdit()
      }}
    >
      {collection.name.trim().slice(0, 2).toUpperCase()}
    </button>
  )
}

/** Over the strip while presets are picked: make them a collection, add them to one, or take them out of one. */
function PickBar({ picked, onDone }: { picked: string[]; onDone: () => void }) {
  const list = useCollections((c) => c.list)
  const [naming, setNaming] = useState(false)
  const holder = list.find((c) => picked.every((code) => c.codes.includes(code)))
  const C = useCollections.getState()
  return (
    <div className={s.bar} role="toolbar" aria-label="Picked presets">
      <span className={s.count}>{picked.length} picked</span>
      {naming ? (
        <NameEditor
          field="Collection name"
          initial={`Collection ${list.length + 1}`}
          saveLabel="Create"
          onSubmit={(name) => {
            C.create(name, picked)
            onDone()
          }}
          onClose={() => setNaming(false)}
        />
      ) : (
        <>
          <button className={s.action} onClick={() => setNaming(true)}>
            New collection
          </button>
          {list
            .filter((c) => c !== holder)
            .map((c) => (
              <button
                key={c.id}
                className={s.action}
                onClick={() => {
                  C.add(c.id, picked)
                  onDone()
                }}
              >
                Add to {c.name}
              </button>
            ))}
          {holder && (
            <button
              className={s.action}
              onClick={() => {
                C.drop(holder.id, picked)
                onDone()
              }}
            >
              Remove from {holder.name}
            </button>
          )}
          <button className={s.action} aria-label="Clear picked presets" title="Clear (Esc)" onClick={onDone}>
            <I.Close width={14} />
          </button>
        </>
      )}
    </div>
  )
}

/** The tile that saves the photo's edit as your own preset, at the strip's start, outside the part that scrolls. */
function SaveSlot({ photo, naming, onName }: { photo: Photo; naming: Naming | null; onName: (n: Naming | null) => void }) {
  const count = useUserPresets((u) => u.list.length)
  if (!hasEdits(photo.edit) && !naming) return null
  return (
    <div className={`${s.group} ${s.save}`}>
      {naming ? (
        <NameEditor
          field="Preset name"
          initial={naming.name}
          saveLabel="Save"
          onSubmit={(name) => useUserPresets.getState().save(name, photo.edit)}
          onClose={() => onName(null)}
        />
      ) : (
        <button
          className={`${s.thumb} ${s.add}`}
          aria-label="Save this edit as a preset"
          title="Save this edit as a preset"
          onClick={() => onName({ kind: 'preset', id: null, name: `My preset ${count + 1}` })}
        >
          <I.Add width={20} />
        </button>
      )}
    </div>
  )
}

/** Your saved presets, under their label; a double-click renames or deletes one. */
function SavedPresets({ photo, base, naming, onName }: { photo: Photo; base: string; naming: Naming | null; onName: (n: Naming | null) => void }) {
  const list = useUserPresets((u) => u.list)
  const load = useUserPresets((u) => u.load)
  const current = useMemo(() => JSON.stringify(presetEdit(photo.edit)), [photo.edit])

  useEffect(() => {
    void load()
  }, [load])

  if (!list.length) return null
  const U = useUserPresets.getState()
  return (
    <div className={s.group} role="group" aria-label="Your presets">
      <div className={`${s.label} ${s.yours}`} title="Your presets" aria-hidden="true">
        U
      </div>
      {naming && (
        <NameEditor
          field="Preset name"
          initial={naming.name}
          saveLabel="Rename"
          deleteLabel={naming.name}
          onSubmit={(name) => U.rename(naming.id!, name)}
          onDelete={() => U.remove(naming.id!)}
          onClose={() => onName(null)}
        />
      )}
      {list.map((r, i) => (
        <Thumb
          key={r.id}
          photo={photo}
          base={base}
          previewKey={'user:' + r.id}
          edit={pasteEdit(photo.edit, r.edit)}
          selected={current === JSON.stringify(r.edit)}
          label={`your preset ${r.name}`}
          title={`U${i + 1} ${r.name}. Double-click to rename or delete.`}
          onClick={() => applyUserPreset(r)}
          onDoubleClick={() => onName({ kind: 'preset', id: r.id, name: r.name })}
        />
      ))}
    </div>
  )
}

const applyUserPreset = (r: RecipeRecord) => useLibrary.getState().updateEdits((e) => pasteEdit(e, r.edit), `Preset ${r.name}`)

function Thumb({
  photo,
  base,
  previewKey,
  edit,
  selected,
  picked = false,
  extraClass = '',
  label,
  title,
  code,
  pos,
  hoverLook,
  onClick,
  onDoubleClick,
  onPointerDown,
  onContextMenu,
}: {
  photo: { id: string }
  base: string
  /** What the preview is cached under for this photo: a look id, or a saved preset's key. */
  previewKey: string
  edit: Edit
  selected: boolean
  /** Picked for a collection (⌘-click). */
  picked?: boolean
  extraClass?: string
  label: string
  title: string
  code?: string
  /** Its place in the arrow keys' order. */
  pos?: number
  /** Shows this look on the photo while the pointer is over the tile. */
  hoverLook?: string
  onClick: (e: React.MouseEvent) => void
  onDoubleClick?: () => void
  onPointerDown?: (e: React.PointerEvent) => void
  onContextMenu?: (e: React.MouseEvent) => void
}) {
  const setPreview = usePreview((p) => p.set)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawn = useRef<ImageBitmap | null>(null)
  const [visible, setVisible] = useState(false)
  const tick = usePreviewTick((t) => t.tick)

  // Previews render only while in view, and a little ahead of the scroll.
  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root: el.closest('[data-strip-scroll]'), rootMargin: '0px 240px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    requestPreview(photo.id, previewKey, edit, base)
    return () => cancelPreview(photo.id, previewKey)
    // The edit follows from the photo's base and the key: a new object each render must not re-request.
  }, [photo.id, base, visible, previewKey])
  // Another photo clears the tile until its previews arrive; the same photo's older preview stays while a newer
  // edit redraws.
  useEffect(() => {
    const el = canvas.current
    if (el && drawn.current) el.getContext('2d')!.clearRect(0, 0, el.width, el.height)
    drawn.current = null
  }, [photo.id])
  useEffect(() => {
    const el = canvas.current
    const entry = previewOf(photo.id, previewKey)
    if (!el || !entry || entry.bitmap === drawn.current) return
    const w = Math.round(el.clientWidth * devicePixelRatio)
    const h = Math.round(el.clientHeight * devicePixelRatio)
    if (!w || !h) return
    if (el.width !== w || el.height !== h) Object.assign(el, { width: w, height: h })
    const [sx, sy, sw, sh] = coverRect(entry.bitmap.width, entry.bitmap.height, w / h)
    el.getContext('2d')!.drawImage(entry.bitmap, sx, sy, sw, sh, 0, 0, w, h)
    drawn.current = entry.bitmap
  }, [tick, photo.id, previewKey, visible])

  return (
    <button
      className={`${s.thumb} ${selected ? s.sel : ''} ${picked ? s.picked : ''} ${extraClass}`}
      data-strip-code={code}
      data-strip-pos={pos}
      aria-pressed={selected}
      aria-label={label}
      title={title}
      onPointerEnter={() => hoverLook && !selected && !stripDrag.active && setPreview(hoverLook)}
      onPointerLeave={() => hoverLook && setPreview(null)}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      onClick={(e) => {
        setPreview(null)
        onClick(e)
      }}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvas} className={s.canvas} aria-hidden="true" />
    </button>
  )
}
