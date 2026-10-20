import { apply, mul, type Mat3 } from './color'
import { tileMatrix } from './geometry'

export interface PixelRect {
  x: number
  y: number
  width: number
  height: number
}
export interface ExportTile extends PixelRect {
  source?: PixelRect
}

/** Source pixels needed by a padded output tile, including all three aberration samples and filtering overlap. */
export function sourceBounds(
  m: Mat3,
  center: [number, number],
  aberration: number,
  sw: number,
  sh: number,
  pw: number,
  ph: number,
): PixelRect {
  const xs: number[] = [],
    ys: number[] = []
  for (const x of [0, 1])
    for (const y of [0, 1]) {
      const uv = apply(m, [x, y, 1])
      for (const k of [1, 1 + aberration * 0.006, 1 - aberration * 0.006]) {
        xs.push((center[0] + (uv[0] - center[0]) * k) * sw)
        ys.push((center[1] + (uv[1] - center[1]) * k) * sh)
      }
    }
  const footprint =
    Math.max(1, Math.hypot(m[0] * sw, m[3] * sh) / pw, Math.hypot(m[1] * sw, m[4] * sh) / ph) * (1 + aberration * 0.006)
  const align = 2 ** Math.ceil(Math.log2(footprint))
  const lo = (values: number[], n: number) =>
    Math.max(0, Math.min(Math.floor((n - 1) / align) * align, (Math.floor(Math.min(...values) / align) - 2) * align))
  const hi = (values: number[], n: number) =>
    Math.max(1, Math.min(Math.ceil(n / align) * align, (Math.ceil(Math.max(...values) / align) + 2) * align))
  const x = lo(xs, sw),
    y = lo(ys, sh)
  return { x, y, width: Math.max(1, hi(xs, sw) - x), height: Math.max(1, hi(ys, sh) - y) }
}

/** Output tiles shrink until both their framebuffer and their original source region fit the GPU. */
export function exportTiles(
  W: number,
  H: number,
  max: number,
  pad: number,
  original?: { width: number; height: number; xform: Mat3; center: [number, number]; aberration: number },
): ExportTile[] {
  const edge = Math.min(2048, max - 2 * pad)
  if (edge < 1) throw new Error('GPU texture limit is too small for export')
  const out: ExportTile[] = []
  const add = (r: PixelRect) => {
    let source: PixelRect | undefined
    if (original) {
      const pw = r.width + 2 * pad,
        ph = r.height + 2 * pad
      const m = mul(original.xform, tileMatrix(r.x - pad, r.y - pad, pw, ph, W, H))
      source = sourceBounds(m, original.center, original.aberration, original.width, original.height, pw, ph)
      if (source.width > max || source.height > max) {
        if (r.width === 1 && r.height === 1)
          throw new Error('This export scale needs a source region larger than the GPU supports')
        if (r.width >= r.height && r.width > 1) {
          const half = Math.floor(r.width / 2)
          add({ ...r, width: half })
          add({ ...r, x: r.x + half, width: r.width - half })
        } else {
          const half = Math.floor(r.height / 2)
          add({ ...r, height: half })
          add({ ...r, y: r.y + half, height: r.height - half })
        }
        return
      }
    }
    out.push({ ...r, source })
  }
  for (let y = 0; y < H; y += edge)
    for (let x = 0; x < W; x += edge) add({ x, y, width: Math.min(edge, W - x), height: Math.min(edge, H - y) })
  return out
}
