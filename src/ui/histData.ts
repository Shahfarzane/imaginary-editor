import { create } from 'zustand'

export interface Hist {
  r: Uint32Array
  g: Uint32Array
  b: Uint32Array
  l: Uint32Array
  max: number
}

export const useHist = create<{ hist: Hist | null; set: (h: Hist) => void }>((set) => ({
  hist: null,
  set: (hist) => set({ hist }),
}))

const W = 192
let canvas: OffscreenCanvas | null = null
let last = 0

/** Sample a rendered frame (before it is transferred) into a 256-bin histogram. Throttled. */
function feed(bmp: CanvasImageSource & { width: number; height: number }) {
  const now = performance.now()
  if (now - last < 120) return
  last = now
  const h = Math.max(1, Math.round((W * bmp.height) / bmp.width))
  canvas ??= new OffscreenCanvas(W, h)
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0, W, h)
  const d = ctx.getImageData(0, 0, W, h).data
  const r = new Uint32Array(256)
  const g = new Uint32Array(256)
  const b = new Uint32Array(256)
  const l = new Uint32Array(256)
  for (let i = 0; i < d.length; i += 4) {
    r[d[i]]++
    g[d[i + 1]]++
    b[d[i + 2]]++
    l[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++
  }
  let max = 1
  // Ignore the clipped end bins when scaling so a blown sky does not flatten the rest.
  for (let i = 1; i < 255; i++) max = Math.max(max, r[i], g[i], b[i])
  useHist.getState().set({ r, g, b, l, max })
}

export const useHistogram = () => ({ feed })
