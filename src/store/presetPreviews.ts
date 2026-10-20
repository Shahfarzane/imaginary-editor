import { create } from 'zustand'
import { ContextLostError, ReleasedSourceError } from '../engine/renderer'
import { cropPixelSize, fitLongEdge } from '../engine/geometry'
import type { Edit } from '../model/edit'
import { getRenderer, gpuSource, thumbSource, useGpu, type Picture } from './render'

// Small renders of a photo through each look, for the presets sidebar. Only the previews on screen are asked for;
// each frame renders a few, within a time budget, so the views and the library thumbnails keep their pace.

/** Long edge of a preview in device pixels: a tile is about 48 x 60 CSS pixels, drawn at 2x and cropped to fill. */
export const PREVIEW_EDGE = 160
/** Previews kept (each a small bitmap); the least recently drawn go first. */
const KEPT = 320
/** Per frame. */
const BUDGET_MS = 8
/** A preview of an older edit is redrawn this long after the photo's edits stop changing, not on every slider step. */
const SETTLE_MS = 350

const NO_DIMS = { contrast: 0, color: 0, tone: 0, character: 0, warmth: 0 }

/** What a preview depends on besides its look: the photo's edit with its preset left out. */
export function baseKey(edit: Edit): string {
  const { preset: _preset, ...rest } = edit
  return JSON.stringify(rest)
}

/** The photo's edit through a look at its defaults, as the hover preview shows it. */
export const previewEdit = (edit: Edit, look: string): Edit => ({ ...edit, preset: { id: look, strength: 1, dims: { ...NO_DIMS } } })

/** The source rectangle of a w x h image that fills a tile of the given aspect (width / height), centered. */
export function coverRect(w: number, h: number, aspect: number): [number, number, number, number] {
  if (w / h > aspect) {
    const sw = h * aspect
    return [(w - sw) / 2, 0, sw, h]
  }
  const sh = w / aspect
  return [0, (h - sh) / 2, w, sh]
}

interface Entry {
  base: string
  bitmap: ImageBitmap
}
interface Job {
  photo: string
  look: string
  base: string
  edit: Edit
  notBefore: number
}

const entries = new Map<string, Entry>()
const jobs = new Map<string, Job>()
const pictures = new Map<string, Picture>()
const lastBase = new Map<string, { base: string; at: number }>()
let scheduled = false

/** Bumped when previews arrive, so the tiles draw them. */
export const usePreviewTick = create<{ tick: number }>(() => ({ tick: 0 }))

const key = (photo: string, look: string) => photo + '|' + look

/** The newest preview of a photo through a look, even one of an older edit (shown until its redraw arrives). */
export function previewOf(photo: string, look: string): Entry | null {
  return entries.get(key(photo, look)) ?? null
}

/** A tile on screen asks for its preview; it is drawn now when there is none, after the edits settle when it is stale. */
export function requestPreview(photo: string, look: string, edit: Edit, base: string) {
  const k = key(photo, look)
  const have = entries.get(k)
  if (have?.base === base) {
    jobs.delete(k)
    return
  }
  const now = performance.now()
  const seen = lastBase.get(photo)
  if (seen?.base !== base) lastBase.set(photo, { base, at: now })
  const settleAt = (lastBase.get(photo)!.at ?? now) + SETTLE_MS
  jobs.set(k, { photo, look, base, edit, notBefore: have ? settleAt : 0 })
  schedule()
}

/** A tile left the screen: its preview waits until it comes back. */
export function cancelPreview(photo: string, look: string) {
  jobs.delete(key(photo, look))
}

function schedule() {
  if (scheduled || !jobs.size) return
  scheduled = true
  requestAnimationFrame(pump)
}

function keep(k: string, entry: Entry) {
  const old = entries.get(k)
  if (old && old.bitmap !== entry.bitmap) old.bitmap.close()
  entries.delete(k)
  entries.set(k, entry)
  while (entries.size > KEPT) {
    const [oldest, e] = entries.entries().next().value!
    e.bitmap.close()
    entries.delete(oldest)
  }
}

function pump() {
  scheduled = false
  const r = getRenderer()
  if (!r) return
  const started = performance.now()
  let drawn = 0
  let waiting = false
  for (const [k, job] of jobs) {
    if (performance.now() - started > BUDGET_MS) break
    if (job.notBefore > performance.now()) {
      waiting = true
      continue
    }
    const pic = pictures.get(job.photo)
    if (!pic) {
      // The library thumbnail's source, decoded once; the next frame renders from it.
      void thumbSource(job.photo).then((p) => {
        if (!p) return jobs.delete(k)
        pictures.set(job.photo, p)
        // Sources of the last few photos only: the library owns them and may let them go.
        while (pictures.size > 3) pictures.delete(pictures.keys().next().value!)
        schedule()
      })
      waiting = true
      continue
    }
    const [cw, ch] = cropPixelSize(job.edit.crop, pic.width, pic.height)
    const [w, h] = fitLongEdge(cw, ch, PREVIEW_EDGE)
    let bitmap: ImageBitmap
    try {
      const src = gpuSource('t:' + job.photo, pic)
      if (!src) break
      bitmap = r.renderBitmap(src, job.edit, w, h)
    } catch (e) {
      // A lost context, or a source the library let go since: the next renderer, or a fresh source, draws it.
      pictures.delete(job.photo)
      if (e instanceof ContextLostError) break
      if (!(e instanceof ReleasedSourceError)) {
        console.warn('preset preview', job.look, e)
        jobs.delete(k)
      }
      continue
    }
    jobs.delete(k)
    keep(k, { base: job.base, bitmap })
    drawn++
  }
  if (drawn) usePreviewTick.setState((t) => ({ tick: t.tick + 1 }))
  if (jobs.size) {
    // Nothing ready to draw, or a render that ran long (a software GPU): leave the next frames to the page.
    if ((waiting && !drawn) || performance.now() - started > 4 * BUDGET_MS) setTimeout(schedule, 60)
    else schedule()
  }
}

// A new renderer after a lost context: previews and sources start over.
useGpu.subscribe(() => {
  for (const e of entries.values()) e.bitmap.close()
  entries.clear()
  pictures.clear()
  usePreviewTick.setState((t) => ({ tick: t.tick + 1 }))
})
