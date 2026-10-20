import type { Crop } from '../model/edit'
import { mul, type Mat3 } from './color'

export function orientedSize(w: number, h: number, rot90: number): [number, number] {
  return rot90 % 2 ? [h, w] : [w, h]
}

/** Crop size in source pixels. */
export function cropPixelSize(crop: Crop, srcW: number, srcH: number): [number, number] {
  const [ow, oh] = orientedSize(srcW, srcH, crop.rot90)
  return [Math.max(1, Math.round(crop.w * ow)), Math.max(1, Math.round(crop.h * oh))]
}

/** Fit (w,h) inside a long-edge limit, keeping aspect. */
export function fitLongEdge(w: number, h: number, max: number): [number, number] {
  const s = Math.min(1, max / Math.max(w, h))
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
}

/**
 * Row-major 3x3 mapping output uv (v up, as in gl_FragCoord) to source
 * texture uv (v = 0 at the top row).
 */
export function outputToSource(crop: Crop, srcW: number, srcH: number): Mat3 {
  const [ow, oh] = orientedSize(srcW, srcH, crop.rot90)
  const flipY: Mat3 = [1, 0, 0, 0, -1, 1, 0, 0, 1]
  const cropM: Mat3 = [crop.w * ow, 0, crop.x * ow, 0, crop.h * oh, crop.y * oh, 0, 0, 1]
  const th = (-crop.straighten * Math.PI) / 180
  const c = Math.cos(th)
  const s = Math.sin(th)
  const cx = ow / 2
  const cy = oh / 2
  // T(C) * R * T(-C)
  const rot: Mat3 = [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0, 0, 1]
  const norm: Mat3 = [1 / ow, 0, 0, 0, 1 / oh, 0, 0, 0, 1]
  let unflip: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  if (crop.flipH) unflip = mul([-1, 0, 1, 0, 1, 0, 0, 0, 1], unflip)
  if (crop.flipV) unflip = mul([1, 0, 0, 0, -1, 1, 0, 0, 1], unflip)
  const unrot: Mat3 = (
    [
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      [0, 1, 0, -1, 0, 1, 0, 0, 1],
      [-1, 0, 1, 0, -1, 1, 0, 0, 1],
      [0, -1, 1, 1, 0, 0, 0, 0, 1],
    ] as Mat3[]
  )[crop.rot90]
  return mul(unrot, mul(unflip, mul(norm, mul(rot, mul(cropM, flipY)))))
}

/** Map tile-local uv to full-output uv (both v up). */
export function tileMatrix(ox: number, oy: number, tw: number, th: number, W: number, H: number): Mat3 {
  return [tw / W, 0, ox / W, 0, th / H, oy / H, 0, 0, 1]
}

/**
 * Largest rect with the crop's aspect, centered on the crop center, that
 * stays inside the image after straightening. Used to auto-fit on rotate.
 */
export function fitCropInRotation(crop: Crop, srcW: number, srcH: number): Crop {
  const [ow, oh] = orientedSize(srcW, srcH, crop.rot90)
  if (crop.straighten === 0) return crop
  // Same rotation the renderer uses to map output to source.
  const phi = (-crop.straighten * Math.PI) / 180
  const c = Math.cos(phi)
  const s = Math.sin(phi)
  // Current rect in pixels.
  let w = crop.w * ow
  let h = crop.h * oh
  const cx = (crop.x + crop.w / 2) * ow
  const cy = (crop.y + crop.h / 2) * oh
  // Scale the rect down until all four corners, rotated back into image
  // space, are inside [0,ow]x[0,oh].
  const inside = (k: number) => {
    const hw = (w * k) / 2
    const hh = (h * k) / 2
    for (const [dx, dy] of [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ]) {
      const px = cx - ow / 2 + dx
      const py = cy - oh / 2 + dy
      const rx = c * px - s * py + ow / 2
      const ry = s * px + c * py + oh / 2
      if (rx < 0 || ry < 0 || rx > ow || ry > oh) return false
    }
    return true
  }
  if (inside(1)) return crop
  let lo = 0
  let hi = 1
  for (let i = 0; i < 30; i++) {
    const m = (lo + hi) / 2
    if (inside(m)) lo = m
    else hi = m
  }
  w *= lo
  h *= lo
  return { ...crop, x: (cx - w / 2) / ow, y: (cy - h / 2) / oh, w: w / ow, h: h / oh }
}
