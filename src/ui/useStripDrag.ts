import { useRef, useState } from 'react'
import { usePreview } from './preview'

/** What a strip drag carries: a preset tile from a group, or a whole group by its label. */
export type DragItem = { kind: 'tile'; code: string; group: string } | { kind: 'group'; group: string }

/** Where it lands: next to a tile of a group (code), or for a group or the empty part of one (code null), next to it. */
export type Drop = { group: string; code: string | null; after: boolean }

/** True while a strip drag is under way, so tiles do not preview the looks the pointer passes over. */
export const stripDrag = { active: false }

/**
 * Drag to reorder with the pointer: a tile or a group label lifts after a few pixels, a copy follows the pointer, a
 * line marks where it lands, the strip scrolls when the pointer nears its ends, and Escape cancels. `accept` says
 * where an item may land; `commit` makes the move.
 */
export function useStripDrag(
  scroller: React.RefObject<HTMLDivElement | null>,
  ghostClass: string,
  accept: (item: DragItem, drop: Drop) => boolean,
  commit: (item: DragItem, drop: Drop) => void,
) {
  const [dragging, setDragging] = useState<DragItem | null>(null)
  const [drop, setDrop] = useState<Drop | null>(null)
  const justDragged = useRef(false)

  const dropAt = (x: number, y: number, item: DragItem): Drop | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const groupEl = el?.closest<HTMLElement>('[data-group]')
    if (!el || !groupEl || !scroller.current?.contains(groupEl)) return null
    const group = groupEl.dataset.group!
    if (item.kind === 'group') {
      const r = groupEl.getBoundingClientRect()
      return { group, code: null, after: x > r.left + r.width / 2 }
    }
    const tile = el.closest<HTMLElement>('[data-strip-code]')
    if (tile && groupEl.contains(tile)) {
      const r = tile.getBoundingClientRect()
      return { group, code: tile.dataset.stripCode!, after: x > r.left + r.width / 2 }
    }
    return { group, code: null, after: true }
  }

  const start = (e: React.PointerEvent, item: DragItem) => {
    // A click with a modifier picks, and touch scrolls the strip.
    if (e.button !== 0 || e.pointerType === 'touch' || e.metaKey || e.ctrlKey || e.shiftKey) return
    const source = e.currentTarget as HTMLElement
    const x0 = e.clientX
    const y0 = e.clientY
    let x = x0
    let y = y0
    let started = false
    let target: Drop | null = null
    let raf = 0
    let ghost: HTMLElement | null = null

    const aim = () => {
      const next = dropAt(x, y, item)
      const ok = next && accept(item, next) ? next : null
      if (ok?.group !== target?.group || ok?.code !== target?.code || ok?.after !== target?.after) {
        target = ok
        setDrop(ok)
      }
    }
    const tick = () => {
      const box = scroller.current?.getBoundingClientRect()
      if (box && y > box.top - 48 && y < box.bottom + 48) {
        const edge = 56
        const over = x < box.left + edge ? x - (box.left + edge) : x > box.right - edge ? x - (box.right - edge) : 0
        if (over) {
          scroller.current!.scrollLeft += Math.max(-24, Math.min(24, over / 2))
          aim()
        }
      }
      raf = requestAnimationFrame(tick)
    }
    const place = () => {
      if (ghost) ghost.style.transform = `translate(${x - 23}px, ${y - 29}px)`
    }
    const lift = () => {
      started = true
      stripDrag.active = true
      usePreview.getState().set(null)
      document.body.style.cursor = 'grabbing'
      ghost = document.createElement('div')
      ghost.className = ghostClass
      const canvas = source.querySelector('canvas')
      if (canvas && canvas.width && canvas.height) {
        const copy = document.createElement('canvas')
        copy.width = canvas.width
        copy.height = canvas.height
        copy.getContext('2d')!.drawImage(canvas, 0, 0)
        ghost.appendChild(copy)
      } else ghost.textContent = source.textContent
      document.body.appendChild(ghost)
      setDragging(item)
      raf = requestAnimationFrame(tick)
    }
    const move = (ev: PointerEvent) => {
      x = ev.clientX
      y = ev.clientY
      if (!started) {
        if (Math.hypot(x - x0, y - y0) < 6) return
        lift()
      }
      place()
      aim()
    }
    const finish = (land: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', key, true)
      cancelAnimationFrame(raf)
      if (!started) return
      ghost?.remove()
      document.body.style.cursor = ''
      stripDrag.active = false
      if (land && target) commit(item, target)
      // The click that follows the release must not also apply the preset.
      justDragged.current = true
      setTimeout(() => (justDragged.current = false), 0)
      setDragging(null)
      setDrop(null)
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || !started) return
      ev.stopPropagation()
      finish(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', key, true)
  }

  return { dragging, drop, start, wasDragged: () => justDragged.current }
}
