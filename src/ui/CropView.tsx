import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import s from './CropView.module.css'
import { useLibrary, type Photo } from '../store/library'
import { cachedProxy, frameFailed, getRenderer, gpuSource, proxySource, useGpu } from '../store/render'
import { showFrame, viewFrame } from './viewFrame'
import { orientedSize } from '../engine/geometry'
import { cropInside, lockedRatio } from '../model/crop'
import type { Crop } from '../model/edit'

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move'

export function CropView({ photo }: { photo: Photo }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  // Render requests and the latest one on screen (read-back frames resolve out of step with requests).
  const asked = useRef(0)
  const shown = useRef(0)
  const [vp, setVp] = useState({ w: 800, h: 600 })
  // The photo whose proxy is decoded and ready to render: readiness belongs to a photo, not to the view.
  const [readyId, setReadyId] = useState(() => (cachedProxy(photo.id) ? photo.id : null))
  // The photo the view is for now; frames rendered for another one never reach the canvas.
  const current = useRef(photo.id)
  // A new renderer after a lost GPU context: render again.
  const epoch = useGpu((g) => g.epoch)
  const [dragging, setDragging] = useState(false)
  const update = useLibrary((st) => st.updateEdits)
  const begin = useLibrary((st) => st.begin)
  const commit = useLibrary((st) => st.commit)

  useLayoutEffect(() => {
    const el = wrap.current!
    const ro = new ResizeObserver(() => setVp({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setVp({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => {
    // Another photo: frames still on their way are for the old one, and until this one's first frame the canvas
    // would show the old photo, so it hides.
    current.current = photo.id
    shown.current = ++asked.current
    if (canvas.current && !cachedProxy(photo.id)) canvas.current.style.visibility = 'hidden'
  }, [photo.id])
  useEffect(() => {
    if (cachedProxy(photo.id)) return setReadyId(photo.id)
    let live = true
    void proxySource(photo.id).then((b) => {
      if (b && live) setReadyId(photo.id)
    })
    return () => {
      live = false
    }
  }, [photo.id])

  const crop = photo.edit.crop
  const [ow, oh] = orientedSize(photo.width, photo.height, crop.rot90)
  const pad = 56
  const dpr = window.devicePixelRatio || 1
  const fit = Math.min((vp.w - pad * 2) / ow, (vp.h - pad * 2) / oh)
  const cssW = Math.max(1, Math.floor(ow * fit))
  const cssH = Math.max(1, Math.floor(oh * fit))

  // Render the whole oriented, straightened frame: the crop is an overlay.
  const viewEdit = useMemo(
    () => ({ ...photo.edit, crop: { ...crop, x: 0, y: 0, w: 1, h: 1 }, border: { ...photo.edit.border, kind: 'none' as const } }),
    [photo.edit, crop],
  )
  useEffect(() => {
    const r = getRenderer()
    const bmp = cachedProxy(photo.id)
    if (!r || !bmp || !canvas.current) return
    const src = gpuSource('p:' + photo.id, bmp)
    if (!src) return
    const [w, h] = [Math.round(cssW * dpr), Math.round(cssH * dpr)]
    const n = ++asked.current
    const id = photo.id
    void viewFrame(
      (space) => r.renderBitmap(src, viewEdit, w, h, 0, space),
      (space) => r.renderLater(src, viewEdit, w, h, 0, space),
    ).then((out) => {
      if (n < shown.current || !canvas.current || current.current !== id) return
      shown.current = n
      showFrame(canvas.current, out)
      canvas.current.style.visibility = ''
    }, frameFailed)
  }, [viewEdit, cssW, cssH, readyId, photo.id, dpr, epoch])

  const drag = useRef<{ h: Handle; x0: number; y0: number; c0: Crop } | null>(null)
  const ratio = lockedRatio(crop, photo.width, photo.height)

  const onDown = (h: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    drag.current = { h, x0: e.clientX, y0: e.clientY, c0: crop }
    setDragging(true)
    begin('Crop')
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = (e.clientX - d.x0) / cssW
    const dy = (e.clientY - d.y0) / cssH
    const c = d.c0
    let { x, y, w, h } = c
    if (d.h === 'move') {
      x = Math.min(Math.max(0, x + dx), 1 - w)
      y = Math.min(Math.max(0, y + dy), 1 - h)
    } else {
      if (d.h.includes('w')) {
        x = c.x + dx
        w = c.w - dx
      }
      if (d.h.includes('e')) w = c.w + dx
      if (d.h.includes('n')) {
        y = c.y + dy
        h = c.h - dy
      }
      if (d.h.includes('s')) h = c.h + dy
      if (ratio) {
        // Keep the pixel ratio; the dominant axis of the drag wins.
        const horiz = d.h === 'e' || d.h === 'w' || (d.h.length === 2 && Math.abs(dx) * ow > Math.abs(dy) * oh)
        if (horiz) {
          const nh = (w * ow) / ratio / oh
          if (d.h.includes('n')) y = c.y + c.h - nh
          else if (!d.h.includes('s')) y = c.y + (c.h - nh) / 2
          h = nh
        } else {
          const nw = (h * oh * ratio) / ow
          if (d.h.includes('w')) x = c.x + c.w - nw
          else if (!d.h.includes('e')) x = c.x + (c.w - nw) / 2
          w = nw
        }
      }
    }
    const next = { ...c, x, y, w, h }
    if (!cropInside(next, photo.width, photo.height)) return
    // A rectangle drawn on the photo in view: other selected photos (other sizes, other ratios) keep their own.
    update((ed, id) => (id === photo.id ? { ...ed, crop: next } : ed), 'Crop')
  }
  const onUp = () => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    commit()
  }

  const box = { left: crop.x * cssW, top: crop.y * cssH, width: crop.w * cssW, height: crop.h * cssH }
  const handles: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

  return (
    <div ref={wrap} className={s.wrap} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
      <div className={s.stage} style={{ width: cssW, height: cssH }}>
        <canvas ref={canvas} className={s.canvas} style={{ width: cssW, height: cssH }} />
        <div className={s.box} style={box} onPointerDown={onDown('move')}>
          <div className={`${s.thirds} ${dragging ? s.show : ''}`}>
            <i style={{ left: '33.33%' }} />
            <i style={{ left: '66.66%' }} />
            <b style={{ top: '33.33%' }} />
            <b style={{ top: '66.66%' }} />
          </div>
          {handles.map((h) => (
            <span key={h} className={`${s.handle} ${s[h]}`} onPointerDown={onDown(h)} />
          ))}
        </div>
        <div className={s.dims}>
          {Math.round(crop.w * ow)} × {Math.round(crop.h * oh)}
        </div>
      </div>
    </div>
  )
}
