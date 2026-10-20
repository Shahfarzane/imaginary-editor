import { zipSync } from 'fflate'
import { getBlob } from './db'
import { bitmapSpace, decodeBlob, requireRenderer } from './render'
import { cropPixelSize, fitLongEdge } from '../engine/geometry'
import { borderLayout, composeBorder } from '../engine/border'
import { iccProfile } from '../engine/icc'
import { encodePng16, encodeTiff16, type Pixels16 } from './encode'
import type { Border } from '../model/edit'
import type { Source, SourceSpace } from '../engine/renderer'
import { LUT_SIZE } from '../engine/renderer'
import { shaper, srgbToLinear } from '../engine/color'
import type { Photo } from './library'
import type { Edit } from '../model/edit'
import { getPreset, ensureSliders } from '../model/presets'
import { toolTablesLoaded } from '../model/toolData'

export type ExportFormat = 'jpeg' | 'png' | 'webp' | 'tiff'
export interface ExportOptions {
  format: ExportFormat
  quality: number // 0..1
  longEdge: number | null // null = full size
  depth?: 8 | 16 // bits per channel for PNG (default 8); TIFF is always 16
  space?: SourceSpace // color space of the file (default sRGB); Display P3 keeps colors beyond sRGB
}

const EXT: Record<ExportFormat, string> = { jpeg: 'jpg', png: 'png', webp: 'webp', tiff: 'tif' }
const MIME: Record<ExportFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  tiff: 'image/tiff',
}

/** Whether these options export 16 bits per channel (through our own encoders; browsers encode 8). */
export const is16Bit = (o: ExportOptions) => o.format === 'tiff' || (o.format === 'png' && o.depth === 16)

export function exportName(photo: Photo, fmt: ExportFormat) {
  const base = photo.name.replace(/\.[^.]+$/, '')
  const preset = getPreset(photo.edit.preset.id)
  return `${base}${preset ? '_' + preset.code : ''}_edit.${EXT[fmt]}`
}

/** Render one photo at export resolution into an encoded Blob. */
export async function renderExport(photo: Photo, opts: ExportOptions, onProgress?: (f: number) => void): Promise<Blob> {
  await Promise.all([ensureSliders(photo.edit.preset.id), toolTablesLoaded])
  const r = requireRenderer()
  const blob = await getBlob('originals', photo.id)
  if (!blob) throw new Error('Original missing')
  const bmp = await decodeBlob(blob)
  const original = cropPixelSize(photo.edit.crop, bmp.width, bmp.height)
  let src: Source
  try {
    src = r.loadExportSource(bmp, bitmapSpace(bmp))
  } catch (error) {
    bmp.close()
    throw error
  }
  try {
    const [cw, ch] = original
    const [W, H] = opts.longEdge ? fitLongEdge(cw, ch, opts.longEdge) : [cw, ch]
    const space = opts.space ?? 'srgb'
    if (is16Bit(opts)) {
      // Rendering is most of the time; encoding the rest.
      const data = await r.renderPixels16(src, photo.edit, W, H, (f) => onProgress?.(f * 0.7), Math.max(cw, ch), space)
      let px: Pixels16 = { width: W, height: H, data }
      if (photo.edit.border.kind !== 'none') px = frame16(px, photo.edit.border, photo.edit.seed, space)
      const icc = iccProfile(space)
      const encoding = (f: number) => onProgress?.(0.7 + f * 0.3)
      return opts.format === 'tiff'
        ? await encodeTiff16(px, icc, encoding)
        : await encodePng16(px, icc, space === 'display-p3' ? 'Display P3' : 'sRGB', encoding)
    }
    const pixels = await r.renderPixels(src, photo.edit, W, H, onProgress, Math.max(cw, ch), space)
    // A canvas in the file's color space; the browser's encoder embeds its profile.
    const canvas = new OffscreenCanvas(W, H)
    canvas
      .getContext('2d', { colorSpace: space })!
      .putImageData(new ImageData(pixels, W, H, { colorSpace: space }), 0, 0)
    const out =
      photo.edit.border.kind === 'none' ? canvas : composeBorder(canvas, photo.edit.border, photo.edit.seed, space)
    return await out.convertToBlob({
      type: MIME[opts.format],
      quality: opts.format === 'png' ? undefined : opts.quality,
    })
  } finally {
    r.deleteSource(src)
    bmp.close()
  }
}

/**
 * A border around 16-bit pixels. Canvas2D draws the frame twice, around a black and around a white stand-in of the
 * photo: the black pass is the frame alone, the difference is the photo's coverage including its anti-aliased clip.
 * The photo goes in through that coverage at 16 bits; the frame's own graphics stay 8-bit.
 */
export function frame16(px: Pixels16, border: Border, seed: number, space: SourceSpace = 'srgb'): Pixels16 {
  const { width: w, height: h, data } = px
  const L = borderLayout(border, w, h)
  const pass = (fill: string) => {
    const stand = new OffscreenCanvas(w, h)
    const g = stand.getContext('2d')!
    g.fillStyle = fill
    g.fillRect(0, 0, w, h)
    return composeBorder(stand, border, seed, space).getContext('2d')!.getImageData(0, 0, L.W, L.H).data
  }
  const black = pass('#000')
  const white = pass('#fff')
  const out = new Uint16Array(L.W * L.H * 3)
  for (let y = 0; y < L.H; y++) {
    const py = y - L.y
    for (let x = 0; x < L.W; x++) {
      const i = (y * L.W + x) * 4
      const o = (y * L.W + x) * 3
      const px = x - L.x
      const a = (white[i + 1] - black[i + 1]) / 255
      const inside = a > 0 && px >= 0 && px < w && py >= 0 && py < h
      const s = (py * w + px) * 3
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(black[i + c] * 257 + (inside ? a * data[s + c] : 0))
    }
  }
  return { width: L.W, height: L.H, data: out }
}

export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export async function exportPhotos(
  photos: Photo[],
  opts: ExportOptions,
  onProgress: (f: number, label: string) => void,
) {
  if (photos.length === 1) {
    const p = photos[0]
    const b = await renderExport(p, opts, (f) => onProgress(f, p.name))
    download(b, exportName(p, opts.format))
    return
  }
  const files: Record<string, Uint8Array> = {}
  const used = new Set<string>()
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i]
    const b = await renderExport(p, opts, (f) => onProgress((i + f) / photos.length, p.name))
    let name = exportName(p, opts.format)
    for (let k = 2; used.has(name); k++) name = name.replace(/(\.\w+)$/, `_${k}$1`)
    used.add(name)
    files[name] = new Uint8Array(await b.arrayBuffer())
  }
  // Images are already compressed: store, do not deflate.
  const zip = zipSync(files, { level: 0 })
  download(new Blob([zip as BlobPart], { type: 'application/zip' }), `imaginary-${photos.length}-photos.zip`)
}

/** The look (global color only) as an Adobe/Resolve compatible .cube file. */
export async function exportCube(edit: Edit, title: string) {
  await Promise.all([ensureSliders(edit.preset.id), toolTablesLoaded])
  const r = requireRenderer()
  // .cube files expect display-referred sRGB input, so sample the look on a
  // regular sRGB grid through the log-shaped LUT.
  const N = 33
  const lut = r.readLut({ ...edit, fx: { ...edit.fx } })
  const S = LUT_SIZE
  const shape = (v: number) => shaper(srgbToLinear(v))
  const sample = (r0: number, g0: number, b0: number) => {
    const p = [shape(r0), shape(g0), shape(b0)].map((v) => Math.min(1, Math.max(0, v)) * (S - 1))
    const i = p.map((v) => Math.min(S - 2, Math.floor(v)))
    const f = p.map((v, k) => v - i[k])
    const o = [0, 0, 0]
    for (let dz = 0; dz < 2; dz++)
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2])
          const idx = (((i[2] + dz) * S + (i[1] + dy)) * S + (i[0] + dx)) * 3
          for (let c = 0; c < 3; c++) o[c] += w * lut[idx + c]
        }
    return o
  }
  const lines = [
    `TITLE "${title.replace(/"/g, '')}"`,
    `# Imaginary look`,
    `LUT_3D_SIZE ${N}`,
    'DOMAIN_MIN 0 0 0',
    'DOMAIN_MAX 1 1 1',
  ]
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let rr = 0; rr < N; rr++) {
        const o = sample(rr / (N - 1), g / (N - 1), b / (N - 1))
        lines.push(o.map((v) => Math.min(1, Math.max(0, v)).toFixed(6)).join(' '))
      }
  download(new Blob([lines.join('\n') + '\n'], { type: 'text/plain' }), `${title.replace(/[^\w-]+/g, '_')}.cube`)
}

/** A contact sheet of the photos as rendered thumbnails with frame numbers. */
/** Contact sheet of the photos' thumbnails, each captioned with its index and the preset code `codeOf` gives. */
export async function exportContactSheet(
  photos: Photo[],
  thumbs: Record<string, ImageBitmap>,
  codeOf: (preset: Photo['edit']['preset']) => string | null,
) {
  const cols = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(photos.length))))
  const cell = 520
  const gap = 36
  const label = 34
  const rows = Math.ceil(photos.length / cols)
  const W = cols * cell + (cols + 1) * gap
  const H = rows * (cell + label) + (rows + 1) * gap + 60
  const c = new OffscreenCanvas(W, H)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#0d0b0a'
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(255,164,64,0.9)'
  ctx.font = '600 22px ui-monospace, Menlo, monospace'
  ctx.fillText(`IMAGINARY  ·  ${new Date().toISOString().slice(0, 10)}  ·  ${photos.length} FRAMES`, gap, 44)
  photos.forEach((p, i) => {
    const b = thumbs[p.id]
    const x = gap + (i % cols) * (cell + gap)
    const y = 60 + gap + Math.floor(i / cols) * (cell + label + gap)
    if (b) {
      const s = Math.min(cell / b.width, cell / b.height)
      const w = b.width * s
      const h = b.height * s
      ctx.drawImage(b, x + (cell - w) / 2, y + (cell - h) / 2, w, h)
    }
    ctx.fillStyle = 'rgba(255,164,64,0.9)'
    ctx.font = '600 18px ui-monospace, Menlo, monospace'
    const code = codeOf(p.edit.preset)
    ctx.fillText(`${i + 1}${code ? '  ' + code : ''}`, x, y + cell + 26)
  })
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  download(blob, `contact-sheet-${photos.length}.jpg`)
}
