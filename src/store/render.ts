import { create } from 'zustand'
import { ContextLostError, ReleasedSourceError, Renderer, type Source, type SourceSpace } from '../engine/renderer'
import { fileColors } from '../engine/profile'
import { isLinear, linearToImageData, type LinearImage } from '../engine/linear'
import { cropPixelSize, fitLongEdge } from '../engine/geometry'
import { lookFor } from '../model/presets'
import type { Edit } from '../model/edit'
import { getBlob, putBlob } from './db'
import { composeBorder } from '../engine/border'
import { isHeic } from '../engine/heif'
import { isRawCandidate } from '../engine/rawFormat'

export const THUMB_EDGE = 640
/**
 * The single view's working copy: long enough to fill this screen at device resolution (a landscape photo at fit on
 * a retina laptop needs over 3000 px), at least 2560 and at most 4096.
 */
export const PROXY_EDGE =
  typeof screen === 'undefined' ? 2560 : Math.min(4096, Math.max(2560, Math.round(Math.max(screen.width, screen.height) * (devicePixelRatio || 1))))

let renderer: Renderer | null = null
/** Whether this browser gives a WebGL2 renderer at all: settled by the first try. */
let supported: boolean | undefined
// After a lost context: when a new renderer may be made, the current wait, and when the last one was made.
let nextTry = 0
let backoff = 0
let madeAt = 0

/** Bumped when a lost renderer is dropped: the views render again, on a new renderer. */
export const useGpu = create<{ epoch: number }>(() => ({ epoch: 0 }))

/** The renderer, made on first use and again after its context is lost; null without WebGL2 or while a new one waits. */
export function getRenderer(): Renderer | null {
  if (renderer?.lost) dropRenderer(renderer)
  if (renderer || supported === false || performance.now() < nextTry) return renderer
  try {
    renderer = Renderer.create(lookFor)
  } catch (e) {
    console.error(e)
  }
  supported ??= renderer !== null
  if (renderer) {
    const r = renderer
    madeAt = performance.now()
    r.canvas.addEventListener('webglcontextlost', () => dropRenderer(r))
  } else if (supported) retryLater()
  return renderer
}

/** Whether the editor can run: WebGL2 worked once (a lost context is replaced, not fatal). */
export const gpuSupported = () => (getRenderer(), supported === true)

/** The renderer for work the user asked for (an export): none means WebGL2 is missing, or a new context is not up yet. */
export function requireRenderer(): Renderer {
  const r = getRenderer()
  if (r) return r
  throw supported ? new ContextLostError() : new Error('WebGL2 unavailable')
}

/**
 * A lost context takes every GPU object with it. Retire its renderer (pending reads reject), forget the sources
 * uploaded to it, and have the views render again on a new one. Replaced, not restored: a new context comes up
 * clean, where a restored one would need every texture, buffer and program rebuilt in place.
 */
function dropRenderer(r: Renderer) {
  if (renderer !== r) return
  r.retire()
  renderer = null
  gpu.clear()
  full = null
  fullLoading = null
  fullRequest++
  // Lost again soon after it was made: the GPU is likely still resetting, so wait longer each time.
  if (performance.now() - madeAt < 5000) retryLater()
  else {
    backoff = 0
    setTimeout(renderAgain, 0)
  }
}

function retryLater() {
  backoff = Math.min(4000, backoff ? backoff * 2 : 250)
  nextTry = performance.now() + backoff
  setTimeout(renderAgain, backoff)
}

function renderAgain() {
  useGpu.setState((g) => ({ epoch: g.epoch + 1 }))
  if (queue.size && !scheduled) {
    scheduled = true
    requestAnimationFrame(pump)
  }
}

/**
 * For a view's frame that failed: a lost context is dropped and the view renders again on the next renderer; a frame
 * from a source released since is skipped, the view's next one uses the current source.
 */
export function frameFailed(e: unknown) {
  if (e instanceof ReleasedSourceError) return
  if (!(e instanceof ContextLostError)) throw e
  if (renderer?.lost) dropRenderer(renderer)
}

/** How the views reach the screen: the space they encode, and whether through a non-blocking readback. */
export interface ViewRoute {
  space: SourceSpace
  readback: boolean
}
let route: ViewRoute | null = null
/**
 * Display P3 where the screen shows it. Where a WebGL bitmap keeps that tag (Chromium) the views take bitmaps as
 * before; where it loses it (WebKit, on every route but a readback; Safari 27.2 beta) they take pixels read back off the
 * GPU without blocking (Renderer.readLater). sRGB bitmaps on sRGB screens.
 */
export function viewRoute(): ViewRoute {
  if (route) return route
  route = { space: 'srgb', readback: false }
  try {
    if (!matchMedia('(color-gamut: p3)').matches) return route
    const oc = new OffscreenCanvas(1, 1)
    const gl = oc.getContext('webgl2')
    if (!gl || !('drawingBufferColorSpace' in gl)) return route
    gl.drawingBufferColorSpace = 'display-p3'
    gl.clearColor(1, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    const c = new OffscreenCanvas(1, 1).getContext('2d', { colorSpace: 'display-p3' })!
    c.drawImage(oc.transferToImageBitmap(), 0, 0)
    // P3 red read back as P3: 255, 0, 0 if the bitmap kept its tag; 234, 51, 35 if it was taken for sRGB.
    const [r, g] = c.getImageData(0, 0, 1, 1, { colorSpace: 'display-p3' }).data
    route = { space: 'display-p3', readback: !(r > 250 && g < 5) }
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    /* sRGB bitmaps */
  }
  return route
}

// ------------------------------------------------------------------ bitmaps

/** A decoded photo: a bitmap, or linear half floats for sources finer than 8 bits (camera RAW). */
export type Picture = ImageBitmap | LinearImage

const thumbSrc = new Map<string, Picture>()
const proxies = new Map<string, Picture>()
const inflight = new Map<string, Promise<Picture>>()

// Bitmaps whose pixels are Display P3 (see decodeBlob); every other bitmap is sRGB.
const p3Bitmaps = new WeakSet<ImageBitmap>()
export const bitmapSpace = (b: Picture): SourceSpace => (!isLinear(b) && p3Bitmaps.has(b) ? 'display-p3' : 'srgb')

/** Something a 2D canvas can draw: the bitmap itself, or 8-bit sRGB of a linear image at most `maxEdge` long. */
export async function drawable(p: Picture, maxEdge?: number): Promise<ImageBitmap> {
  return isLinear(p) ? createImageBitmap(linearToImageData(p, maxEdge), { premultiplyAlpha: 'none' }) : p
}

/**
 * A photo's pixels, at most `maxEdge` on the long side. A file with a profile other than sRGB (an iPhone's
 * Display P3) is drawn into a P3 2D canvas, which color-manages it in every browser, and its bitmap is marked P3:
 * WebKit uploads a decoded image to WebGL as it is, so its P3 values would otherwise be read as sRGB.
 */
export async function decodeBlob(blob: Blob, maxEdge?: number): Promise<Picture> {
  const { bitmap: full, asIs } = await decodeFull(blob, maxEdge)
  // RAW comes back linear and already no larger than maxEdge.
  if (isLinear(full)) return full
  const [w, h] = maxEdge ? fitLongEdge(full.width, full.height, Math.min(maxEdge, Math.max(full.width, full.height))) : [full.width, full.height]
  if (asIs && fileColors(new Uint8Array(await blob.slice(0, 1 << 20).arrayBuffer())) !== 'srgb') {
    const c = new OffscreenCanvas(w, h)
    const g = c.getContext('2d', { colorSpace: 'display-p3' })!
    g.imageSmoothingQuality = 'high'
    g.drawImage(full, 0, 0, w, h)
    full.close()
    const p3 = c.transferToImageBitmap()
    p3Bitmaps.add(p3)
    return p3
  }
  if (w === full.width && h === full.height) return full
  const small = await createImageBitmap(full, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
  full.close()
  return small
}

/**
 * Camera RAW through LibRaw; otherwise the browser's own decoder, and for HEIC where it has none (all but Safari), the
 * bundled one. `asIs`: the browser's decode, in whatever space the file's profile names; the others are sRGB already.
 */
async function decodeFull(blob: Blob, maxEdge?: number): Promise<{ bitmap: Picture; asIs: boolean }> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer())
  if (isRawCandidate(head)) {
    const { decodeRaw } = await import('./raw')
    try {
      return { bitmap: await decodeRaw(blob, maxEdge), asIs: false }
    } catch (e) {
      // A plain TIFF looks like the TIFF family of RAW files; the browser may still read it.
      console.warn('not decoded as RAW', e)
    }
  }
  try {
    return { bitmap: await createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' }), asIs: true }
  } catch (e) {
    if (!isHeic(head)) throw e
    const { decodeHeic } = await import('./heic')
    return { bitmap: await decodeHeic(blob), asIs: false }
  }
}

export async function thumbSource(id: string): Promise<Picture | null> {
  const hit = thumbSrc.get(id)
  if (hit) return hit
  const key = 't:' + id
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      const blob = await getBlob('thumbSources', id)
      if (!blob) throw new Error('missing thumb source')
      return decodeBlob(blob)
    })()
    inflight.set(key, p)
  }
  try {
    const bmp = await p
    thumbSrc.set(id, bmp)
    return bmp
  } catch {
    return null
  } finally {
    inflight.delete(key)
  }
}

export async function proxySource(id: string): Promise<Picture | null> {
  const hit = proxies.get(id)
  if (hit) {
    // LRU refresh
    proxies.delete(id)
    proxies.set(id, hit)
    return hit
  }
  const key = 'p:' + id
  let p = inflight.get(key)
  if (!p) {
    p = (async () => {
      const blob = await getBlob('originals', id)
      if (!blob) throw new Error('missing original')
      return decodeBlob(blob, PROXY_EDGE)
    })()
    inflight.set(key, p)
  }
  try {
    const bmp = await p
    proxies.set(id, bmp)
    while (proxies.size > 4) {
      const [k, v] = proxies.entries().next().value!
      proxies.delete(k)
      v.close()
      dropGpu('p:' + k)
    }
    return bmp
  } catch {
    return null
  } finally {
    inflight.delete(key)
  }
}

export const cachedProxy = (id: string) => proxies.get(id) ?? null

// ------------------------------------------------------------------ GPU sources

const gpu = new Map<string, Source>()
export function gpuSource(key: string, bmp: Picture): Source | null {
  const r = getRenderer()
  if (!r) return null
  const hit = gpu.get(key)
  if (hit) {
    gpu.delete(key)
    gpu.set(key, hit)
    return hit
  }
  let s: Source
  try {
    s = r.loadSource(bmp, bitmapSpace(bmp))
  } catch (e) {
    if (e instanceof ContextLostError) return null
    throw e
  }
  gpu.set(key, s)
  while (gpu.size > 48) {
    const [k, v] = gpu.entries().next().value!
    gpu.delete(k)
    r.deleteSource(v)
  }
  return s
}
function dropGpu(key: string) {
  const s = gpu.get(key)
  if (s) {
    getRenderer()?.deleteSource(s)
    gpu.delete(key)
  }
}
export function forgetPhoto(id: string) {
  dropGpu('t:' + id)
  dropGpu('p:' + id)
  thumbSrc.get(id)?.close()
  thumbSrc.delete(id)
  proxies.get(id)?.close()
  proxies.delete(id)
  useThumbs.getState().drop(id)
  dropSharp(id)
}

// ------------------------------------------------------------------ thumbnails

interface ThumbState {
  bitmaps: Record<string, ImageBitmap>
  set: (id: string, b: ImageBitmap) => void
  drop: (id: string) => void
}
export const useThumbs = create<ThumbState>((set, get) => ({
  bitmaps: {},
  set: (id, b) => {
    const old = get().bitmaps[id]
    set({ bitmaps: { ...get().bitmaps, [id]: b } })
    // Close later so a tile mid-draw never sees a detached bitmap.
    if (old && old !== b) setTimeout(() => old.close(), 1000)
  },
  drop: (id) => {
    const { [id]: gone, ...rest } = get().bitmaps
    gone?.close()
    set({ bitmaps: rest })
  },
}))

export async function loadPersistedThumb(id: string) {
  const blob = await getBlob('thumbs', id)
  if (!blob) return false
  const b = await createImageBitmap(blob)
  if (!useThumbs.getState().bitmaps[id]) useThumbs.getState().set(id, b)
  return true
}

type EditGetter = (id: string) => Edit | undefined
let getEdit: EditGetter = () => undefined
export const setEditGetter = (g: EditGetter) => (getEdit = g)

const queue = new Set<string>()
let scheduled = false
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function requestThumb(id: string) {
  queue.add(id)
  if (!scheduled) {
    scheduled = true
    requestAnimationFrame(pump)
  }
}

async function pump() {
  scheduled = false
  const r = getRenderer()
  if (!r) return
  const started = performance.now()
  for (const id of Array.from(queue)) {
    if (performance.now() - started > 12) break
    queue.delete(id)
    const edit = getEdit(id)
    if (!edit) continue
    const bmp = thumbSrc.get(id)
    if (!bmp) {
      void thumbSource(id).then((b) => b && requestThumb(id))
      continue
    }
    const src = gpuSource('t:' + id, bmp)
    if (!src) continue
    const [cw, ch] = cropPixelSize(edit.crop, bmp.width, bmp.height)
    const [w, h] = fitLongEdge(cw, ch, THUMB_EDGE)
    let out: ImageBitmap
    try {
      out = r.renderBitmap(src, edit, w, h)
    } catch (e) {
      if (!(e instanceof ContextLostError)) throw e
      // Rendered again once a new renderer is up (renderAgain).
      queue.add(id)
      break
    }
    if (edit.border.kind !== 'none') {
      const framed = composeBorder(out, edit.border, edit.seed).transferToImageBitmap()
      out.close()
      out = framed
    }
    useThumbs.getState().set(id, out)
    schedulePersist(id)
  }
  if (queue.size && !scheduled) {
    scheduled = true
    requestAnimationFrame(pump)
  }
}

function schedulePersist(id: string) {
  clearTimeout(persistTimers.get(id))
  persistTimers.set(
    id,
    setTimeout(async () => {
      persistTimers.delete(id)
      const b = useThumbs.getState().bitmaps[id]
      if (!b) return
      try {
        const c = new OffscreenCanvas(b.width, b.height)
        c.getContext('2d')!.drawImage(b, 0, 0)
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
        await putBlob('thumbs', id, blob)
      } catch {
        /* bitmap closed mid-way; next edit persists again */
      }
    }, 1500),
  )
}

// ------------------------------------------------------------------ sharp grid tiles

/**
 * A grid tile shown larger than its thumbnail (THUMB_EDGE) is rendered again at its own size from the single view's
 * working copy, one tile at a time once the grid settles. Its texture goes as soon as the tile is drawn; the tiles
 * stay up to a pixel budget, least recently used first.
 */
export interface SharpTile {
  bitmap: ImageBitmap
  /** The edit it was rendered with (edits are replaced, never changed in place) and its size in device pixels. */
  edit: Edit
  w: number
  h: number
}
export const useSharp = create<{ tiles: Record<string, SharpTile> }>(() => ({ tiles: {} }))

const SHARP_PIXELS = 48e6
const SHARP_SETTLE_MS = 250
const sharpWant = new Map<string, { w: number; h: number; fullLong: number }>()
let sharpTimer: ReturnType<typeof setTimeout> | undefined
let sharpBusy = false

/** A visible tile wants a render of `w` x `h` device pixels; `fullLong` is the photo's long edge at full size. */
export function requestSharp(id: string, w: number, h: number, fullLong: number) {
  sharpWant.set(id, { w, h, fullLong })
  clearTimeout(sharpTimer)
  sharpTimer = setTimeout(() => void sharpPump(), SHARP_SETTLE_MS)
}
export const cancelSharp = (id: string) => sharpWant.delete(id)

async function sharpPump() {
  if (sharpBusy) return
  sharpBusy = true
  try {
    for (const [id, want] of sharpWant) {
      sharpWant.delete(id)
      const edit = getEdit(id)
      const have = useSharp.getState().tiles[id]
      if (!edit || (have && have.edit === edit && have.w === want.w && have.h === want.h)) continue
      const pic = await proxySource(id)
      const r = getRenderer()
      // The edit may have moved on while the copy decoded; a newer request renders it.
      if (!pic || !r || getEdit(id) !== edit) continue
      let out: ImageBitmap
      try {
        const src = r.loadSource(pic, bitmapSpace(pic))
        try {
          out = r.renderBitmap(src, edit, want.w, want.h, want.fullLong)
        } finally {
          r.deleteSource(src)
        }
      } catch (e) {
        if (e instanceof ContextLostError || e instanceof ReleasedSourceError) continue
        throw e
      }
      if (edit.border.kind !== 'none') {
        const framed = composeBorder(out, edit.border, edit.seed).transferToImageBitmap()
        out.close()
        out = framed
      }
      keepSharp(id, { bitmap: out, edit, w: want.w, h: want.h })
      // Yield between tiles so scrolling and edits stay smooth.
      await new Promise((done) => setTimeout(done, 0))
    }
  } finally {
    sharpBusy = false
    if (sharpWant.size) sharpTimer = setTimeout(() => void sharpPump(), SHARP_SETTLE_MS)
  }
}

function keepSharp(id: string, tile: SharpTile) {
  const { [id]: old, ...rest } = useSharp.getState().tiles
  const tiles: Record<string, SharpTile> = { ...rest, [id]: tile }
  // Oldest first (insertion order); drop until the budget holds, never the tile just made.
  let pixels = Object.values(tiles).reduce((n, t) => n + t.bitmap.width * t.bitmap.height, 0)
  for (const [k, t] of Object.entries(tiles)) {
    if (pixels <= SHARP_PIXELS || k === id) continue
    pixels -= t.bitmap.width * t.bitmap.height
    delete tiles[k]
    setTimeout(() => t.bitmap.close(), 1000)
  }
  useSharp.setState({ tiles })
  // Close later so a tile mid-draw never sees a detached bitmap.
  if (old) setTimeout(() => old.bitmap.close(), 1000)
}

function dropSharp(id: string) {
  sharpWant.delete(id)
  const { [id]: gone, ...rest } = useSharp.getState().tiles
  if (!gone) return
  useSharp.setState({ tiles: rest })
  setTimeout(() => gone.bitmap.close(), 1000)
}

// ------------------------------------------------------------------ full resolution (loupe)

let full: { id: string; src: Source } | null = null
let fullLoading: { id: string; p: Promise<Source | null> } | null = null
// The current full-size request. A new one, a lost renderer and releaseFull each supersede it: a decode that
// finishes after that publishes nothing, so it can never delete or replace the source a view holds now.
let fullRequest = 0

/** GPU source of the original at full resolution. Only one is kept alive; null when superseded or unavailable. */
export function fullSource(id: string): Promise<Source | null> {
  if (full?.id === id) {
    // Back on the photo that is loaded: a decode still running for another one is superseded, or it would replace
    // (and delete) the source handed back here when it finishes.
    if (fullLoading) {
      fullRequest++
      fullLoading = null
    }
    return Promise.resolve(full.src)
  }
  if (fullLoading?.id === id) return fullLoading.p
  const request = ++fullRequest
  const p = (async () => {
    const blob = await getBlob('originals', id)
    if (!blob || request !== fullRequest) return null
    const bmp = await decodeBlob(blob)
    try {
      // Superseded while decoding: another photo, the loupe closed, or a lost context.
      if (request !== fullRequest) return null
      // The renderer as of now: a context lost during the decode has been replaced.
      const r = getRenderer()
      if (!r) return null
      const src = r.loadSource(bmp, bitmapSpace(bmp))
      disposeFull()
      full = { id, src }
      return src
    } catch (e) {
      if (e instanceof ContextLostError) return null
      throw e
    } finally {
      bmp.close()
    }
  })()
  fullLoading = { id, p }
  const settled = () => {
    if (fullLoading?.p === p) fullLoading = null
  }
  p.then(settled, settled)
  return p
}

/** The loupe is done: free the full-size source, and let no decode still running publish another. */
export function releaseFull() {
  fullRequest++
  fullLoading = null
  disposeFull()
}

function disposeFull() {
  if (full) {
    getRenderer()?.deleteSource(full.src)
    getRenderer()?.releaseRegion()
    full = null
  }
}
