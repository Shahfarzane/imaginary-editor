// Dev-only: measure a look on ColorChecker patches and the neutral axis (Lab deltas), plus the other probes
// the browser console reaches through window.__studio.
import { LUT_SIZE } from '../engine/renderer'
import { linearToOklab, linearToSrgb, shaper, shaperInv, srgbToLinear, type Vec3 } from '../engine/color'
import { defaultEdit } from '../model/edit'
import { ensureSliders, loadAllSliders, PRESETS } from '../model/presets'
import { getRenderer } from '../store/render'

const PATCHES: [string, number, number, number][] = [
  ['darkSkin', 115, 82, 68],
  ['lightSkin', 194, 150, 130],
  ['sky', 98, 122, 157],
  ['foliage', 87, 108, 67],
  ['blueFlower', 133, 128, 177],
  ['bluishGreen', 103, 189, 170],
  ['orange', 214, 126, 44],
  ['purplishBlue', 80, 91, 166],
  ['modRed', 193, 90, 99],
  ['purple', 94, 60, 108],
  ['yellowGreen', 157, 188, 64],
  ['orangeYellow', 224, 163, 46],
  ['blue', 56, 61, 150],
  ['green', 70, 148, 73],
  ['red', 175, 54, 60],
  ['yellow', 231, 199, 31],
  ['magenta', 187, 86, 149],
  ['cyan', 8, 133, 161],
]

function lab(rgb: number[]): [number, number, number] {
  const [r, g, b] = rgb.map(srgbToLinear)
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29)
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]
}

function sampler(lut: Float32Array) {
  const N = LUT_SIZE
  return (rgb: number[]) => {
    const p = rgb.map((v) => shaper(srgbToLinear(v)) * (N - 1))
    const i = p.map((v) => Math.min(N - 2, Math.floor(v)))
    const f = p.map((v, k) => v - i[k])
    const out = [0, 0, 0]
    for (let dz = 0; dz < 2; dz++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2])
          const idx = (((i[2] + dz) * N + (i[1] + dy)) * N + (i[0] + dx)) * 3
          for (let c = 0; c < 3; c++) out[c] += w * lut[idx + c]
        }
    return out
  }
}

export function lookStats(presetId: string | null) {
  const r = getRenderer()!
  const e = defaultEdit(1)
  e.preset.id = presetId
  const s = sampler(r.readLut(e))
  const gray = (v: number) => s([v, v, v]).map((x) => Math.round(x * 255))
  const hue = (a: number, b: number) => (Math.atan2(b, a) * 180) / Math.PI
  const patches: Record<string, { dL: number; dC: number; dH: number }> = {}
  let cRatio = 0
  let n = 0
  for (const [name, R, G, B] of PATCHES) {
    const inp = [R / 255, G / 255, B / 255]
    const a = lab(inp)
    const bOut = lab(s(inp).map((x) => Math.min(1, Math.max(0, x))))
    const ca = Math.hypot(a[1], a[2])
    const cb = Math.hypot(bOut[1], bOut[2])
    let dH = hue(bOut[1], bOut[2]) - hue(a[1], a[2])
    dH = ((dH + 540) % 360) - 180
    patches[name] = { dL: +(bOut[0] - a[0]).toFixed(1), dC: +((cb / ca - 1) * 100).toFixed(0), dH: +dH.toFixed(0) }
    if (ca > 20) {
      cRatio += cb / ca
      n++
    }
  }
  const mid = lab(s([0.5, 0.5, 0.5]))
  const lo = lab(s([0.4, 0.4, 0.4]))
  const hi = lab(s([0.6, 0.6, 0.6]))
  const inLo = lab([0.4, 0.4, 0.4])
  const inHi = lab([0.6, 0.6, 0.6])
  return {
    id: presetId,
    black: gray(0),
    shadow: gray(0.1),
    mid: gray(0.5),
    white: gray(1),
    midL: +(mid[0] - lab([0.5, 0.5, 0.5])[0]).toFixed(1),
    midSlope: +((hi[0] - lo[0]) / (inHi[0] - inLo[0])).toFixed(2),
    midCast: [+mid[1].toFixed(1), +mid[2].toFixed(1)],
    shadowCast: (() => {
      const l = lab(s([0.15, 0.15, 0.15]))
      return [+l[1].toFixed(1), +l[2].toFixed(1)]
    })(),
    cRatio: +(cRatio / n).toFixed(2),
    patches,
  }
}

export const allLookStats = () => [lookStats(null), ...PRESETS.map((p) => lookStats(p.id))]
export { linearToSrgb }

/** Contact sheet of every preset on one photo, as a PNG blob URL (dev only). */
export async function presetSheet(photoName: string, cols = 8, cell = 300) {
  const { useLibrary } = await import('../store/library')
  const { thumbSource, gpuSource } = await import('../store/render')
  const r = getRenderer()!
  const photo = useLibrary.getState().photos.find((p) => p.name === photoName)!
  const bmp = (await thumbSource(photo.id))!
  const src = gpuSource('t:' + photo.id, bmp)!
  const ids: (string | null)[] = [null, ...PRESETS.map((p) => p.id)]
  const h = Math.round((cell * bmp.height) / bmp.width)
  const rows = Math.ceil(ids.length / cols)
  const c = new OffscreenCanvas(cols * cell, rows * (h + 22))
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.font = '14px sans-serif'
  ids.forEach((id, i) => {
    const e = defaultEdit(7)
    e.preset.id = id
    const out = r.renderBitmap(src, e, cell, h)
    const x = (i % cols) * cell
    const y = Math.floor(i / cols) * (h + 22)
    ctx.drawImage(out, x, y)
    out.close()
    ctx.fillStyle = '#ddd'
    ctx.fillText(id ?? 'original', x + 6, y + h + 16)
  })
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Average color of a render with an edit patch applied (dev only). */
export async function renderAvg(photoName: string, patch: (e: ReturnType<typeof defaultEdit>) => void, size = 128) {
  const { useLibrary } = await import('../store/library')
  const { thumbSource, gpuSource } = await import('../store/render')
  const r = getRenderer()!
  const photo = useLibrary.getState().photos.find((p) => p.name === photoName)!
  const bmp = (await thumbSource(photo.id))!
  const src = gpuSource('t:' + photo.id, bmp)!
  const e = defaultEdit(7)
  patch(e)
  // Slider tables load on demand; a moved slider measured before its table arrives would use the fallback.
  await ensureSliders(e.preset.id)
  const out = r.renderBitmap(src, e, size, size)
  const c = new OffscreenCanvas(size, size)
  const ctx = c.getContext('2d')!
  ctx.drawImage(out, 0, 0)
  const d = ctx.getImageData(0, 0, size, size).data
  const s = [0, 0, 0]
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) s[k] += d[i + k]
  return s.map((v) => Math.round(v / (d.length / 4)))
}

/** Export a photo at full size and report dimensions and timing (dev only). */
export async function exportProbe(photoName: string, longEdge: number | null = null) {
  const { useLibrary } = await import('../store/library')
  const { renderExport } = await import('../store/export')
  const photo = useLibrary.getState().photos.find((p) => p.name === photoName)!
  const t0 = performance.now()
  const blob = await renderExport(photo, { format: 'jpeg', quality: 0.92, longEdge })
  const ms = Math.round(performance.now() - t0)
  const bmp = await createImageBitmap(blob)
  const out = { w: bmp.width, h: bmp.height, kb: Math.round(blob.size / 1024), ms }
  bmp.close()
  return out
}

/** Export to base64 JPEG for offline inspection (dev only). */
export async function exportB64(photoName: string, patch?: (e: ReturnType<typeof defaultEdit>) => void, longEdge: number | null = null) {
  const { useLibrary } = await import('../store/library')
  const { renderExport } = await import('../store/export')
  const p = useLibrary.getState().photos.find((x) => x.name === photoName)!
  const edit = structuredClone(p.edit)
  patch?.(edit)
  const blob = await renderExport({ ...p, edit }, { format: 'png', quality: 1, longEdge })
  const buf = new Uint8Array(await blob.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Render every tool at its extremes and measure image statistics (dev only). */
export async function toolSweep(photoName: string) {
  const { useLibrary } = await import('../store/library')
  const { thumbSource, gpuSource } = await import('../store/render')
  const { TOOL_IDS, FX_IDS } = await import('../model/edit')
  const r = getRenderer()!
  const photo = useLibrary.getState().photos.find((p) => p.name === photoName)!
  const bmp = (await thumbSource(photo.id))!
  const src = gpuSource('t:' + photo.id, bmp)!
  const W = 320
  const H = Math.round((W * bmp.height) / bmp.width)
  const stats = (e: ReturnType<typeof defaultEdit>) => {
    const out = r.renderBitmap(src, e, W, H)
    const c = new OffscreenCanvas(W, H)
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(out, 0, 0)
    out.close()
    const d = ctx.getImageData(0, 0, W, H).data
    const n = W * H
    const Y = new Float32Array(n)
    let sr = 0, sg = 0, sb = 0, chroma = 0
    for (let i = 0; i < n; i++) {
      const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2]
      sr += R; sg += G; sb += B
      Y[i] = 0.2126 * R + 0.7152 * G + 0.0722 * B
      chroma += Math.max(R, G, B) - Math.min(R, G, B)
    }
    const mean = Y.reduce((a, b) => a + b, 0) / n
    const std = Math.sqrt(Y.reduce((a, b) => a + (b - mean) ** 2, 0) / n)
    const sorted = Float32Array.from(Y).sort()
    let lap = 0
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x
        lap += Math.abs(4 * Y[i] - Y[i - 1] - Y[i + 1] - Y[i - W] - Y[i + W])
      }
    let corner = 0, center = 0
    const k = Math.round(W * 0.1)
    for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) corner += Y[y * W + x]
    for (let y = (H >> 1) - (k >> 1); y < (H >> 1) + (k >> 1); y++) for (let x = (W >> 1) - (k >> 1); x < (W >> 1) + (k >> 1); x++) center += Y[y * W + x]
    return {
      mean: +mean.toFixed(1),
      std: +std.toFixed(1),
      p2: Math.round(sorted[Math.floor(n * 0.02)]),
      p98: Math.round(sorted[Math.floor(n * 0.98)]),
      chroma: +(chroma / n).toFixed(1),
      rb: +(sr / sb).toFixed(3),
      g: +((2 * sg) / (sr + sb)).toFixed(3),
      detail: +(lap / n).toFixed(2),
      vig: +(corner / center).toFixed(3),
    }
  }
  const base = stats(defaultEdit(7))
  const rows: Record<string, unknown> = { base }
  for (const id of TOOL_IDS) {
    for (const v of [-1, 1]) {
      if (v < 0 && ['fade', 'sharpen'].includes(id)) continue
      const e = defaultEdit(7)
      e.tools[id] = v
      rows[`${id}${v > 0 ? '+' : '-'}`] = stats(e)
    }
  }
  for (const id of FX_IDS) {
    const e = defaultEdit(7)
    e.fx[id] = 1
    if (id.startsWith('grain') && id !== 'grain') e.fx.grain = 0.6
    if (id === 'halationSpread') e.fx.halation = 0.8
    if (id === 'bloomSpread') e.fx.bloom = 0.8
    if (id === 'leakWarmth') e.fx.leak = 0.6
    if (id === 'vignetteFeather') e.fx.vignette = 0.8
    rows[`${id}+`] = stats(e)
  }
  return rows
}

/** Time preview renders at a given size for three kinds of edits (dev only). */
export async function perfProbe(photoName: string, W = 2560, H = 1440, runs = 8) {
  const { useLibrary } = await import('../store/library')
  const { proxySource, gpuSource } = await import('../store/render')
  const r = getRenderer()!
  const photo = useLibrary.getState().photos.find((p) => p.name === photoName)!
  const bmp = (await proxySource(photo.id))!
  const src = gpuSource('p:' + photo.id, bmp)!
  const gl = r.gl
  const px = new Uint8Array(4)
  const time = (mutate: (e: ReturnType<typeof defaultEdit>, i: number) => void) => {
    const ts: number[] = []
    for (let i = 0; i < runs; i++) {
      const e = defaultEdit(7)
      e.preset.id = 'lb1'
      e.tools.clarity = 0.4
      e.tools.shadows = 0.3
      e.fx.grain = 0.5
      e.fx.halation = 0.4
      mutate(e, i)
      const t0 = performance.now()
      const b = r.renderBitmap(src, e, W, H)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px) // force completion
      ts.push(performance.now() - t0)
      b.close()
    }
    ts.sort((a, b) => a - b)
    return +ts[Math.floor(ts.length / 2)].toFixed(1)
  }
  return {
    size: `${W}x${H}`,
    toolDrag_ms: time((e, i) => (e.tools.exposure = i * 0.01)), // LUT bake + develop
    grainDrag_ms: time((e, i) => (e.fx.grain = 0.3 + i * 0.01)), // develop only
    cropDrag_ms: time((e, i) => (e.crop.x = i * 0.001)), // geometry + filters + develop
  }
}

/**
 * Exact bake outputs at LUT lattice points (no interpolation), for checking the bake
 * against an offline model of it and for scoring looks (dev only). Async: a preset's slider table loads first.
 */
export async function latticeDump(
  look: import('../engine/look').LookParams | string | null,
  step = 4,
  dims: Partial<ReturnType<typeof defaultEdit>['preset']['dims']> = {},
  tools: Partial<ReturnType<typeof defaultEdit>['tools']> = {},
) {
  const r = getRenderer()!
  const e = defaultEdit(1)
  Object.assign(e.preset.dims, dims)
  Object.assign(e.tools, tools)
  if (typeof look === 'string') {
    e.preset.id = look
    await ensureSliders(look)
  } else if (look) {
    e.preset.id = 'custom'
    e.preset.custom = look
  }
  const lut = r.readLut(e)
  const N = LUT_SIZE
  const idx: number[] = []
  for (let i = 0; i < N; i += step) idx.push(i)
  if (idx[idx.length - 1] !== N - 1) idx.push(N - 1)
  const inp: number[] = []
  const out: number[] = []
  const v = (k: number) => linearToSrgb(shaperInv(k / (N - 1)))
  for (const b of idx)
    for (const g of idx)
      for (const rr of idx) {
        inp.push(v(rr), v(g), v(b))
        const o = ((b * N + g) * N + rr) * 3
        out.push(lut[o], lut[o + 1], lut[o + 2])
      }
  return { inp, out }
}

/** Every preset's resolved look parameters (dev only). */
export async function allLooks() {
  const { lookFor } = await import('../model/presets')
  await loadAllSliders()
  return Object.fromEntries(PRESETS.map((p) => [p.id, lookFor(p.id)]))
}

/** Grain statistics on an export: std by luminance, autocorrelation, chroma vs mono (dev only). */
export async function grainProbe(photoName: string, fx: Partial<ReturnType<typeof defaultEdit>['fx']>) {
  const { useLibrary } = await import('../store/library')
  const { renderExport } = await import('../store/export')
  const p = useLibrary.getState().photos.find((x) => x.name === photoName)!
  const pixels = async (withGrain: boolean) => {
    const edit = structuredClone(p.edit)
    edit.fx = { ...edit.fx, grain: 0, grainColor: 0, grainSize: 0, grainRough: 0, ...(withGrain ? fx : {}) }
    const blob = await renderExport({ ...p, edit }, { format: 'png', quality: 1, longEdge: null })
    const bmp = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    return ctx.getImageData(0, 0, bmp.width, bmp.height)
  }
  const base = await pixels(false)
  const g = await pixels(true)
  const { width: w, height: h } = base
  const bins = 10
  const sum = new Float64Array(bins), sq = new Float64Array(bins), cnt = new Float64Array(bins)
  const lags = [1, 2, 3, 4, 6, 8]
  const ac = new Float64Array(lags.length), acN = new Float64Array(lags.length)
  let v0 = 0, v0n = 0, cr = 0, cm = 0
  const at = (i: number) => (g.data[i] - base.data[i] + g.data[i + 1] - base.data[i + 1] + g.data[i + 2] - base.data[i + 2]) / 3
  for (let y = Math.floor(h * 0.2); y < h * 0.8; y += 2)
    for (let x = Math.floor(w * 0.2); x < w * 0.8; x += 2) {
      const i = (y * w + x) * 4
      const m = at(i)
      const Y = (0.2126 * base.data[i] + 0.7152 * base.data[i + 1] + 0.0722 * base.data[i + 2]) / 255
      const b = Math.min(bins - 1, Math.floor(Y * bins))
      sum[b] += m; sq[b] += m * m; cnt[b]++
      const dr = g.data[i] - base.data[i]
      cr += (dr - m) ** 2; cm += m * m
      v0 += m * m; v0n++
      lags.forEach((L, k) => { if (x + L < w * 0.8) { ac[k] += m * at(i + L * 4); acN[k]++ } })
    }
  return {
    w, h,
    stdByLuma: Array.from(sum, (s, b) => (cnt[b] > 50 ? Math.sqrt(sq[b] / cnt[b] - (s / cnt[b]) ** 2) : null)),
    autocorr: lags.map((L, k) => [L, ac[k] / acN[k] / (v0 / v0n)]),
    chromaVsMono: Math.sqrt(cr / v0n) / Math.sqrt(cm / v0n),
  }
}

/** Full-resolution export, box-averaged k x k in display space, as a PNG data URL (dev only). */
export async function exportSmall(photoName: string, patch?: (e: ReturnType<typeof defaultEdit>) => void, k = 8) {
  const { useLibrary } = await import('../store/library')
  const { renderExport } = await import('../store/export')
  const p = useLibrary.getState().photos.find((x) => x.name === photoName)!
  const edit = structuredClone(p.edit)
  patch?.(edit)
  const blob = await renderExport({ ...p, edit }, { format: 'png', quality: 1, longEdge: null })
  const bmp = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  const ctx = c.getContext('2d')!
  ctx.drawImage(bmp, 0, 0)
  const src = ctx.getImageData(0, 0, bmp.width, bmp.height).data
  const W = Math.floor(bmp.width / k)
  const H = Math.floor(bmp.height / k)
  const out = new OffscreenCanvas(W, H)
  const octx = out.getContext('2d')!
  const img = octx.createImageData(W, H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0]
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * bmp.width + x * k + dx) * 4
          acc[0] += src[i]; acc[1] += src[i + 1]; acc[2] += src[i + 2]
        }
      const o = (y * W + x) * 4
      img.data.set([acc[0] / (k * k), acc[1] / (k * k), acc[2] / (k * k), 255], o)
    }
  octx.putImageData(img, 0, 0)
  const b = await out.convertToBlob({ type: 'image/png' })
  const buf = new Uint8Array(await b.arrayBuffer())
  let s = ''
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
  return btoa(s)
}

/**
 * What each preset does to the ColorChecker patches and a gray ramp, as Oklab in and out
 * (dev only). Each preset's chip color in presetColors.ts comes from these.
 */
export function presetSwatches() {
  const r = getRenderer()!
  const grays = [0.1, 0.3, 0.5, 0.7, 0.9]
  const inputs = [...PATCHES.map(([, R, G, B]) => [R / 255, G / 255, B / 255]), ...grays.map((v) => [v, v, v])]
  const out: Record<string, { code: string; family: string; in: number[][]; out: number[][] }> = {}
  for (const p of PRESETS) {
    const e = defaultEdit(1)
    e.preset.id = p.id
    const s = sampler(r.readLut(e))
    out[p.id] = {
      code: p.code,
      family: p.family,
      in: inputs.map(oklab),
      out: inputs.map((rgb) => oklab(s(rgb).map((x) => Math.min(1, Math.max(0, x))))),
    }
  }
  return out
}

const oklab = (rgb: number[]) => linearToOklab(rgb.map(srgbToLinear) as Vec3)
