import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import s from './Library.module.css'
import { activePhoto, useLibrary, type Photo } from '../store/library'
import { cachedProxy, cancelSharp, frameFailed, fullSource, getRenderer, gpuSource, proxySource, releaseFull, requestSharp, useGpu, useSharp, useThumbs } from '../store/render'
import { frameSpace, showFrame, viewFrame } from './viewFrame'
import type { Source } from '../engine/renderer'
import { cropPixelSize } from '../engine/geometry'
import { GridLook, LookOverlay } from './LookOverlay'
import { borderLayout, composeBorder } from '../engine/border'
import { defaultEdit, hasEdits, type Edit } from '../model/edit'
import * as I from './icons'
import { useUi, zoomLabel } from './uiState'
import { openFilePicker } from './DropZone'
import { CropView } from './CropView'
import { useHistogram } from './histData'
import { PresetStrip, STRIP_BAND, stripShown } from './PresetStrip'
import { useSettings } from './settings'
import { usePreview, withPreview } from './preview'
import { visiblePhotos } from './visible'
import { justify } from './justify'

/** Extra top inset in the fit view so the photo clears the selection bar (SelectionBar): 24 + pad = 64px. */
const BAR_BAND = 24

export function Library() {
  const photos = useLibrary((st) => st.photos)
  const ready = useLibrary((st) => st.ready)
  const gridSize = useLibrary((st) => st.gridSize)
  const panel = useLibrary((st) => st.panel)
  const active = useLibrary(activePhoto)

  if (!ready) return null
  if (!photos.length) return <Empty />
  if (panel === 'adjust' && active) return <CropView photo={active} />
  if (gridSize >= 0.99 && active) return <SingleOrLoupe photo={active} />
  return <Grid />
}

function Empty() {
  return (
    <div className={s.empty}>
      <button className={s.emptyBtn} onClick={openFilePicker}>
        <span className={s.emptyTitle}>Add your photos</span>
        <span className={s.emptySub}>Drop images anywhere, paste, or click to browse. Everything stays on this device.</span>
      </button>
    </div>
  )
}

// ------------------------------------------------------------------ grid

/** Gap between photos, in the grid and between its rows. */
const GRID_GAP = 16
const GRID_PAD = 20

/** Aspect ratio a photo shows at in the grid: its crop, plus its border when it has one. */
function gridAspect(p: Photo) {
  const [cw, ch] = cropPixelSize(p.edit.crop, p.width, p.height)
  const L = borderLayout(p.edit.border, cw, ch)
  return L.W / L.H
}

/** Photos in justified rows: each at its own aspect ratio, rows filling the width. The size slider sets the row height. */
function Grid() {
  const photos = useLibrary((st) => st.photos)
  const selected = useLibrary((st) => st.selected)
  const isolate = useLibrary((st) => st.isolate)
  const gridSize = useLibrary((st) => st.gridSize)
  const filter = useUi((u) => u.filter)
  const active = useLibrary(activePhoto)
  const stripOpen = useUi((u) => u.stripOpen)
  // The strip is a setting; with it off, the look sliders stay.
  const stripOn = useSettings((x) => x.presetsStrip)
  const shown = useLibrary((st) => stripShown(stripOpen, st))
  const strip = shown && stripOn
  // The strip floats over the bottom of the grid, which scrolls its last row clear of it.
  const padBottom = strip ? STRIP_BAND + 20 : 60
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 1200, h: 800 })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [])

  const visible = visiblePhotos(photos, selected, isolate, filter)
  const t = (gridSize + 1) / 2
  const width = Math.max(100, box.w - GRID_PAD * 2)
  // Row height from 110px up to most of the view, on a log scale like the old column width.
  const maxH = Math.max(160, box.h - 64 - padBottom)
  const target = Math.round(110 * Math.pow(maxH / 110, t))
  const aspectKey = visible.map((p) => gridAspect(p).toFixed(4)).join()
  const rows = useMemo(
    () => justify(aspectKey ? aspectKey.split(',').map(Number) : [], width, target, GRID_GAP, maxH),
    [aspectKey, width, target, maxH],
  )

  return (
    <>
      <div
        ref={ref}
        className={s.grid}
        style={{ gap: GRID_GAP, padding: `64px ${GRID_PAD}px ${padBottom}px` }}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as HTMLElement).dataset.row !== undefined) useLibrary.getState().clearSelection()
        }}
      >
        {rows.map((r, k) => (
          <div key={k} className={s.row} data-row style={{ gap: GRID_GAP, height: r.height }}>
            {r.items.map((i, j) => {
              const p = visible[i]
              return <Tile key={p.id} photo={p} width={r.widths[j]} height={r.height} selected={selected.includes(p.id)} />
            })}
          </div>
        ))}
      </div>
      {shown && active && <GridLook />}
      {strip && active && <PresetStrip photo={active} />}
    </>
  )
}

function Tile({ photo, width, height, selected }: { photo: Photo; width: number; height: number; selected: boolean }) {
  const thumb = useThumbs((t) => t.bitmaps[photo.id])
  const sharp = useSharp((t) => t.tiles[photo.id])
  const canvas = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  // Device pixels the tile covers. Shown well beyond its thumbnail, it asks for a render at its own size while in view.
  const dpr = window.devicePixelRatio || 1
  const [cw, ch] = cropPixelSize(photo.edit.crop, photo.width, photo.height)
  // The image inside its border: the border is drawn around the render, as for the thumbnail.
  const k = (width * dpr) / borderLayout(photo.edit.border, cw, ch).W
  const w = Math.round(cw * k)
  const h = Math.round(ch * k)
  const blurry = !!thumb && width * dpr > thumb.width * 1.15
  const fresh = sharp && sharp.edit === photo.edit && sharp.w === w && sharp.h === h ? sharp.bitmap : null
  const bmp = fresh ?? thumb

  useEffect(() => {
    const el = canvas.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  useEffect(() => {
    if (!blurry || !visible) return
    requestSharp(photo.id, w, h, Math.max(cw, ch))
    return () => void cancelSharp(photo.id)
  }, [blurry, visible, w, h, cw, ch, photo.id, photo.edit])
  useEffect(() => {
    const c = canvas.current
    if (!c || !bmp) return
    try {
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
    } catch {
      /* bitmap was replaced and closed; the next one redraws */
    }
  }, [bmp])

  return (
    <div
      className={`${s.tile} ${selected ? s.sel : ''}`}
      style={{ width, height }}
      onPointerDown={(e) => {
        const mode = e.shiftKey ? 'range' : e.metaKey || e.ctrlKey ? 'toggle' : 'replace'
        const st = useLibrary.getState()
        // Clicking an already selected photo inside a multi-selection keeps the set.
        if (mode === 'replace' && selected && st.selected.length > 1) useLibrary.setState({ focus: photo.id })
        else st.select(photo.id, mode)
      }}
      onDoubleClick={() => {
        useLibrary.getState().select(photo.id)
        useLibrary.getState().setGridSize(1)
      }}
    >
      <canvas ref={canvas} className={s.tileCanvas} aria-label={photo.name} />
      {!bmp && <div className={s.tileLoading} />}
      {hasEdits(photo.edit) && (
        <span className={s.edited} title="Edited" aria-label="Edited">
          <I.Tools width={14} height={14} />
        </span>
      )}
      {photo.favorite && (
        <span className={s.marks} aria-label="Favorite">
          <I.Heart width={13} className={s.heart} />
        </span>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ single view

function SingleOrLoupe({ photo }: { photo: Photo }) {
  const zoom = useUi((u) => u.zoom)
  return zoom === 'fit' ? <SingleView photo={photo} /> : <ZoomView photo={photo} z={zoom} />
}

export const originalEdit = (e: Edit): Edit => ({ ...defaultEdit(e.seed) })

function useViewport(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ w: 800, h: 600 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [ref])
  return size
}

function SingleView({ photo }: { photo: Photo }) {
  const wrap = useRef<HTMLDivElement>(null)
  const main = useRef<HTMLCanvasElement>(null)
  const before = useRef<HTMLCanvasElement>(null)
  const vp = useViewport(wrap)
  const showOriginal = useLibrary((st) => st.showOriginal)
  const split = useUi((u) => u.split)
  const setSplit = useUi((u) => u.setSplit)
  const thumb = useThumbs((t) => t.bitmaps[photo.id])
  const [proxyReady, setProxyReady] = useState(() => !!cachedProxy(photo.id))
  // The photo the main canvas last drew. Until it is this one, the canvas is hidden over the
  // thumbnail placeholder: it is still blank on first open, or holds the previous photo.
  const [drawn, setDrawn] = useState<string | null>(null)
  const hist = useHistogram()
  const previewId = usePreview((p) => p.id)

  useEffect(() => {
    let alive = true
    setProxyReady(!!cachedProxy(photo.id))
    void proxySource(photo.id).then((b) => alive && b && setProxyReady(true))
    return () => {
      alive = false
    }
  }, [photo.id])

  const edit = useMemo(
    () => (showOriginal ? originalEdit(photo.edit) : withPreview(photo.edit, previewId)),
    [showOriginal, photo.edit, previewId],
  )
  const [cw, ch] = cropPixelSize(edit.crop, photo.width, photo.height)
  const L = borderLayout(edit.border, cw, ch)
  const pad = 40
  const dpr = window.devicePixelRatio || 1
  // The preset strip keeps its band under the photo free while it is up.
  const stripOpen = useUi((u) => u.stripOpen)
  const stripOn = useSettings((x) => x.presetsStrip)
  const strip = useLibrary((st) => stripShown(stripOpen, st)) && stripOn
  const fit = Math.min((vp.w - pad * 2) / L.W, (vp.h - BAR_BAND - pad - (strip ? STRIP_BAND : pad)) / L.H, 1 / dpr)
  const scale = fit
  // Device pixels per image pixel at fit, for the zoom menu and slider.
  const fitScale = fit * dpr
  useEffect(() => useUi.getState().setFitScale(fitScale), [fitScale])
  const cssW = Math.max(1, Math.floor(L.W * scale))
  const cssH = Math.max(1, Math.floor(L.H * scale))
  // Pixel size of the photo itself inside the (optional) border.
  const imgW = Math.max(1, Math.round(cw * scale * dpr))
  const imgH = Math.max(1, Math.round(ch * scale * dpr))

  const frame = useRef(0)
  // A new renderer after a lost GPU context: render again.
  const epoch = useGpu((g) => g.epoch)
  // Render requests and the latest one on screen, per canvas (read-back frames resolve out of step with requests).
  const asked = useRef(0)
  const shown = useRef(0)
  const beforeAsked = useRef(0)
  const beforeShown = useRef(0)
  const beforeKey = useMemo(() => JSON.stringify([photo.id, cssW, cssH, photo.edit.seed]), [photo.id, cssW, cssH, photo.edit.seed])
  useEffect(() => {
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const r = getRenderer()
      const bmp = cachedProxy(photo.id)
      if (!r || !bmp || !main.current) return
      const src = gpuSource('p:' + photo.id, bmp)
      if (!src) return
      const id = photo.id
      const n = ++asked.current
      const fullLong = Math.max(cw, ch)
      void viewFrame(
        (space) => r.renderBitmap(src, edit, imgW, imgH, fullLong, space),
        (space) => r.renderLater(src, edit, imgW, imgH, fullLong, space),
      ).then((out) => {
        // Read-back frames arrive a frame or two later; once a newer one is up, an older one is dropped.
        if (n < shown.current || !main.current) return
        shown.current = n
        hist.feed(out)
        const framed = edit.border.kind === 'none' ? out : composeBorder(out, edit.border, edit.seed, frameSpace())
        if (framed !== out && out instanceof ImageBitmap) out.close()
        showFrame(main.current, framed)
        setDrawn(id)
      }, frameFailed)
    })
  }, [edit, imgW, imgH, proxyReady, photo.id, epoch])

  // The "before" layer for split view only re-renders when geometry changes.
  useEffect(() => {
    if (split === null) return
    const r = getRenderer()
    const bmp = cachedProxy(photo.id)
    if (!r || !bmp || !before.current) return
    const src = gpuSource('p:' + photo.id, bmp)
    if (!src) return
    const orig = { ...originalEdit(photo.edit), crop: photo.edit.crop, border: photo.edit.border }
    const n = ++beforeAsked.current
    const fullLong = Math.max(cw, ch)
    void viewFrame(
      (space) => r.renderBitmap(src, orig, imgW, imgH, fullLong, space),
      (space) => r.renderLater(src, orig, imgW, imgH, fullLong, space),
    ).then((out) => {
      if (n < beforeShown.current || !before.current) return
      beforeShown.current = n
      const framed = orig.border.kind === 'none' ? out : composeBorder(out, orig.border, photo.edit.seed, frameSpace())
      if (framed !== out && out instanceof ImageBitmap) out.close()
      showFrame(before.current, framed)
    }, frameFailed)
  }, [split === null, beforeKey, proxyReady, JSON.stringify(photo.edit.crop), JSON.stringify(photo.edit.border), epoch])

  return (
    <div ref={wrap} className={s.single} style={{ paddingTop: BAR_BAND, paddingBottom: strip ? STRIP_BAND : 0 }}>
      <div
        className={s.frame}
        style={{ width: cssW, height: cssH }}
        onDoubleClick={(e) => {
          if (split !== null) return
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          useUi.getState().setZoomAt([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height])
          useUi.getState().setZoom(1)
        }}
      >
        {thumb && <ThumbPlaceholder bmp={thumb} />}
        <canvas
          ref={main}
          className={`${s.mainCanvas} ${drawn === photo.id ? '' : s.pending}`}
          style={{ width: cssW, height: cssH }}
        />
        {split !== null && (
          <>
            <canvas
              ref={before}
              className={s.mainCanvas}
              style={{ width: cssW, height: cssH, clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}
            />
            <SplitHandle value={split} onChange={setSplit} />
          </>
        )}
        {showOriginal ? <div className={s.badge}>Original</div> : split === null && <LookOverlay edit={photo.edit} />}
      </div>
      {strip && <PresetStrip photo={photo} />}
    </div>
  )
}

function ThumbPlaceholder({ bmp }: { bmp: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    try {
      c.width = bmp.width
      c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
    } catch {
      /* closed */
    }
  }, [bmp])
  return <canvas ref={ref} className={s.placeholder} />
}

function SplitHandle({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div
      className={s.splitArea}
      onPointerDown={(e) => {
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        onChange(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))
      }}
      onPointerMove={(e) => {
        if (!(e.buttons & 1)) return
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        onChange(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))
      }}
    >
      <div className={s.splitLine} style={{ left: `${value * 100}%` }}>
        <span className={s.splitKnob} />
        <span className={s.splitLabelL}>Before</span>
        <span className={s.splitLabelR}>After</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ zoomed view

/**
 * Any zoom other than fit. Below 100% the image is rendered at the scaled
 * size (only the visible part); above 100% the visible part is rendered 1:1
 * from the full-resolution original and magnified with crisp pixels.
 */
function ZoomView({ photo, z }: { photo: Photo; z: number }) {
  const wrap = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const vp = useViewport(wrap)
  const [src, setSrc] = useState<Source | null>(null)
  const showOriginal = useLibrary((st) => st.showOriginal)
  const zoomAt = useUi((u) => u.zoomAt)
  const dpr = window.devicePixelRatio || 1
  // A lost GPU context takes the full-size source with it: upload it again to the new renderer.
  const epoch = useGpu((g) => g.epoch)

  useEffect(() => {
    let alive = true
    void fullSource(photo.id).then((s) => alive && setSrc(s))
    return () => {
      alive = false
    }
  }, [photo.id, epoch])
  useEffect(() => () => releaseFull(), [])

  const edit = useMemo(() => (showOriginal ? { ...originalEdit(photo.edit), crop: photo.edit.crop } : photo.edit), [showOriginal, photo.edit])
  const [W, H] = src ? cropPixelSize(edit.crop, src.width, src.height) : [1, 1]
  // Size of the image we render against, and how much each rendered pixel is magnified.
  const OW = z < 1 ? Math.max(1, Math.round(W * z)) : W
  const OH = z < 1 ? Math.max(1, Math.round(H * z)) : H
  const mag = Math.max(1, z)
  const rw = Math.max(1, Math.min(OW, Math.ceil((vp.w * dpr) / mag)))
  const rh = Math.max(1, Math.min(OH, Math.ceil((vp.h * dpr) / mag)))
  const [nx, ny] = zoomAt ?? [0.5, 0.5]
  const rx = Math.round(Math.min(Math.max(0, nx * OW - rw / 2), OW - rw))
  const ry = Math.round(Math.min(Math.max(0, ny * OH - rh / 2), OH - rh))

  const frame = useRef(0)
  const asked = useRef(0)
  const shown = useRef(0)
  useEffect(() => {
    if (!src) return
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => {
      const r = getRenderer()
      const c = canvas.current
      if (!r || !c) return
      const n = ++asked.current
      void viewFrame(
        (space) => r.renderRegion(src, edit, OW, OH, rx, ry, rw, rh, Math.max(W, H), space),
        (space) => r.regionLater(src, edit, OW, OH, rx, ry, rw, rh, Math.max(W, H), space),
      ).then((out) => {
        if (n < shown.current || !canvas.current) return
        shown.current = n
        showFrame(canvas.current, out)
      }, frameFailed)
    })
  }, [src, edit, OW, OH, W, H, rx, ry, rw, rh])

  const drag = useRef<{ x: number; y: number; nx: number; ny: number } | null>(null)
  return (
    <div
      ref={wrap}
      className={s.loupe}
      onPointerDown={(e) => {
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, y: e.clientY, nx: (rx + rw / 2) / OW, ny: (ry + rh / 2) / OH }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d) return
        const k = dpr / mag
        useUi.getState().setZoomAt([d.nx - ((e.clientX - d.x) * k) / OW, d.ny - ((e.clientY - d.y) * k) / OH])
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={() => {
        useUi.getState().setZoom('fit')
        useUi.getState().setZoomAt(null)
      }}
    >
      <canvas ref={canvas} style={{ width: (rw * mag) / dpr, height: (rh * mag) / dpr, imageRendering: mag > 1 ? 'pixelated' : 'auto' }} />
      <div className={s.badge}>{src ? `${zoomLabel(z)} · ${W} × ${H}` : 'Loading full resolution…'}</div>
    </div>
  )
}
