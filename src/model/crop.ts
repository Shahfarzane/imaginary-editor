import type { Crop } from './edit'
import { fitCropInRotation, orientedSize } from '../engine/geometry'

export const ASPECTS: { id: string; label: string; ratio: number | null }[] = [
  { id: '4:5', label: '4:5', ratio: 4 / 5 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
  { id: '9:16', label: '9:16', ratio: 9 / 16 },
  { id: '1:1', label: '1:1', ratio: 1 },
  { id: '5:4', label: '5:4', ratio: 5 / 4 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '3:2', label: '3:2', ratio: 3 / 2 },
  { id: '16:9', label: '16:9', ratio: 16 / 9 },
  { id: '1.91:1', label: '1.91', ratio: 1.91 },
]

export function parseRatio(s: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:x/]\s*(\d+(?:\.\d+)?)\s*$/.exec(s)
  if (m) {
    const r = parseFloat(m[1]) / parseFloat(m[2])
    return Number.isFinite(r) && r > 0.05 && r < 20 ? r : null
  }
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 0.05 && n < 20 ? n : null
}

/** Pixel aspect ratio the crop should keep, or null for free-form. */
export function lockedRatio(crop: Crop, srcW: number, srcH: number): number | null {
  if (crop.aspect === 'free') return null
  if (crop.aspect === 'original') {
    const [ow, oh] = orientedSize(srcW, srcH, crop.rot90)
    return ow / oh
  }
  return parseRatio(crop.aspect)
}

/** Largest rect of the given pixel ratio centered on the current crop, inside the image. */
export function applyAspect(crop: Crop, aspect: string, srcW: number, srcH: number): Crop {
  const next = { ...crop, aspect }
  const ratio = lockedRatio(next, srcW, srcH)
  if (!ratio) return next
  const [ow, oh] = orientedSize(srcW, srcH, crop.rot90)
  const cx = crop.x + crop.w / 2
  const cy = crop.y + crop.h / 2
  // Max size centered at (cx, cy) inside [0,1]^2.
  const maxW = Math.min(cx, 1 - cx) * 2
  const maxH = Math.min(cy, 1 - cy) * 2
  let w = maxW
  let h = (w * ow) / ratio / oh
  if (h > maxH) {
    h = maxH
    w = (h * oh * ratio) / ow
  }
  // Prefer the full image when the center allows it.
  if (maxW < 0.999 || maxH < 0.999) {
    const fw = 1
    const fh = (fw * ow) / ratio / oh
    const [bw, bh] = fh <= 1 ? [fw, fh] : [(1 * oh * ratio) / ow, 1]
    if (bw >= w && bh >= h) {
      w = bw
      h = bh
      return fitCropInRotation({ ...next, w, h, x: (1 - w) / 2, y: (1 - h) / 2 }, srcW, srcH)
    }
  }
  return fitCropInRotation({ ...next, w, h, x: cx - w / 2, y: cy - h / 2 }, srcW, srcH)
}

export function rotate90(crop: Crop, dir: 1 | -1): Crop {
  const rot90 = (((crop.rot90 + dir) % 4) + 4) % 4 as Crop['rot90']
  const r =
    dir === 1
      ? { x: 1 - (crop.y + crop.h), y: crop.x, w: crop.h, h: crop.w }
      : { x: crop.y, y: 1 - (crop.x + crop.w), w: crop.h, h: crop.w }
  // A fixed ratio flips with the frame (4:5 becomes 5:4).
  const flipped = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(crop.aspect)
  const aspect = flipped ? `${flipped[2]}:${flipped[1]}` : crop.aspect
  return { ...crop, ...r, rot90, aspect }
}

export function flip(crop: Crop, axis: 'h' | 'v'): Crop {
  return axis === 'h'
    ? { ...crop, flipH: !crop.flipH, x: 1 - crop.x - crop.w, straighten: -crop.straighten }
    : { ...crop, flipV: !crop.flipV, y: 1 - crop.y - crop.h, straighten: -crop.straighten }
}

/** Whether every corner of the crop stays inside the straightened image. */
export function cropInside(crop: Crop, srcW: number, srcH: number): boolean {
  if (crop.x < -1e-6 || crop.y < -1e-6 || crop.x + crop.w > 1 + 1e-6 || crop.y + crop.h > 1 + 1e-6) return false
  if (crop.w < 0.02 || crop.h < 0.02) return false
  if (!crop.straighten) return true
  return fitCropInRotation(crop, srcW, srcH) === crop
}

function maxRect(crop: Crop, ratio: number, srcW: number, srcH: number): Crop {
  const [ow, oh] = orientedSize(srcW, srcH, crop.rot90)
  const cx = crop.x + crop.w / 2
  const cy = crop.y + crop.h / 2
  const maxW = Math.min(cx, 1 - cx) * 2
  const maxH = Math.min(cy, 1 - cy) * 2
  let w = maxW
  let h = (w * ow) / ratio / oh
  if (h > maxH) {
    h = maxH
    w = (h * oh * ratio) / ow
  }
  return fitCropInRotation({ ...crop, w, h, x: cx - w / 2, y: cy - h / 2 }, srcW, srcH)
}

/**
 * Straighten keeps the crop inside the rotated image. A crop that was at its
 * maximum size stays maximal (it grows back when the angle returns to 0);
 * a tighter crop only shrinks when it has to.
 */
export function setStraighten(crop: Crop, deg: number, srcW: number, srcH: number): Crop {
  const [ow, oh] = orientedSize(srcW, srcH, crop.rot90)
  const ratio = (crop.w * ow) / (crop.h * oh)
  const prevMax = maxRect(crop, ratio, srcW, srcH)
  if (crop.w >= prevMax.w * 0.995) return maxRect({ ...crop, straighten: deg }, ratio, srcW, srcH)
  return fitCropInRotation({ ...crop, straighten: deg }, srcW, srcH)
}
