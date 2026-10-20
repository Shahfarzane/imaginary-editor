import type { Border } from '../model/edit'

export interface BorderLayout {
  W: number
  H: number
  x: number
  y: number
  w: number
  h: number
}

/** Outer canvas size and image placement for a border around a w×h image. */
export function borderLayout(b: Border, w: number, h: number): BorderLayout {
  const short = Math.min(w, h)
  const k = 0.35 + b.size * 1.3 // size 0..1 -> 0.35..1.65
  switch (b.kind) {
    case 'solid': {
      const p = Math.round(short * 0.06 * k)
      return { W: w + p * 2, H: h + p * 2, x: p, y: p, w, h }
    }
    case 'instant': {
      const side = Math.round(short * 0.055 * k)
      const bottom = Math.round(short * 0.2 * k)
      return { W: w + side * 2, H: h + side + bottom, x: side, y: side, w, h }
    }
    case 'film35': {
      // Rebate proportions of 35mm: frame height 24 units, film width 35.
      const landscape = w >= h
      const frameShort = landscape ? h : w
      const rebate = Math.round(frameShort * (5.5 / 24))
      const gap = Math.round(frameShort * 0.08)
      return landscape
        ? { W: w + gap * 2, H: h + rebate * 2, x: gap, y: rebate, w, h }
        : { W: w + rebate * 2, H: h + gap * 2, x: rebate, y: gap, w, h }
    }
    case 'medium': {
      const p = Math.round(short * 0.05 * k)
      const label = Math.round(short * 0.06)
      return { W: w + p * 2, H: h + p * 2 + label, x: p, y: p, w, h }
    }
    default:
      return { W: w, H: h, x: 0, y: 0, w, h }
  }
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

/** Draw the image with its border into a new canvas. */
export function composeBorder(
  img: CanvasImageSource & { width: number; height: number },
  b: Border,
  seed = 1,
  space: PredefinedColorSpace = 'srgb',
): OffscreenCanvas {
  const L = borderLayout(b, img.width, img.height)
  const c = new OffscreenCanvas(L.W, L.H)
  // In the photo's color space, so a wide-gamut photo is not clipped to sRGB on its way into the frame.
  const ctx = c.getContext('2d', { colorSpace: space })!
  const rnd = mulberry(seed)
  if (b.kind === 'film35' || b.kind === 'medium') {
    drawFilm(ctx, img, L, b.kind, rnd)
    return c
  }
  ctx.fillStyle = b.color
  ctx.fillRect(0, 0, L.W, L.H)
  if (b.kind === 'instant') {
    // Paper tooth: a faint noise so the frame reads as print stock, not a flat fill.
    const g = ctx.createLinearGradient(0, 0, 0, L.H)
    g.addColorStop(0, 'rgba(0,0,0,0.0)')
    g.addColorStop(1, 'rgba(0,0,0,0.05)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, L.W, L.H)
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.25)'
    ctx.shadowBlur = Math.max(1, L.w * 0.004)
    ctx.fillStyle = '#000'
    ctx.fillRect(L.x, L.y, L.w, L.h)
    ctx.restore()
  }
  ctx.drawImage(img, L.x, L.y)
  return c
}

function drawFilm(ctx: Ctx, img: CanvasImageSource, L: BorderLayout, kind: 'film35' | 'medium', rnd: () => number) {
  const base = '#0d0b0a'
  ctx.fillStyle = base
  ctx.fillRect(0, 0, L.W, L.H)
  const landscape = L.w >= L.h
  const amber = 'rgba(255, 164, 64, 0.88)'
  const s = Math.min(L.w, L.h)
  const font = (px: number) => `600 ${Math.max(6, Math.round(px))}px ui-monospace, "SF Mono", Menlo, monospace`

  if (kind === 'film35') {
    const rebate = landscape ? L.y : L.x
    const holeW = rebate * 0.34
    const holeH = rebate * 0.46
    const pitch = s * (4.75 / 24)
    const run = landscape ? L.W : L.H
    const offset = (rnd() * pitch) % pitch
    ctx.fillStyle = '#e9e2d4'
    for (let t = -offset; t < run; t += pitch) {
      for (const side of [0, 1]) {
        const across = side === 0 ? rebate * 0.22 : (landscape ? L.H : L.W) - rebate * 0.22 - holeH
        if (landscape) roundRect(ctx, t, across, holeW, holeH, holeW * 0.22)
        else roundRect(ctx, across, t, holeH, holeW, holeW * 0.22)
        ctx.fill()
      }
    }
    // Edge code along the rebate, between the holes and the frame.
    ctx.fillStyle = amber
    ctx.font = font(rebate * 0.13)
    ctx.textBaseline = 'middle'
    const n = 1 + Math.floor(rnd() * 34)
    const code = `IMAGINARY 400  ${n}  ▸ ${n}A`
    const pos = rebate * 0.84
    if (landscape) {
      ctx.fillText(code, L.x + L.w * 0.08, pos)
      ctx.fillText(`${n}A`, L.x + L.w * 0.72, L.H - pos)
      ctx.fillText('◆ 5063', L.x + L.w * 0.38, L.H - pos)
    } else {
      ctx.save()
      ctx.translate(pos, L.y + L.h * 0.08)
      ctx.rotate(Math.PI / 2)
      ctx.fillText(code, 0, 0)
      ctx.restore()
    }
    ctx.save()
    roundRect(ctx, L.x, L.y, L.w, L.h, s * 0.012)
    ctx.clip()
    ctx.drawImage(img, L.x, L.y)
    ctx.restore()
    return
  }

  // 120: filed-out rebate with slightly uneven edges.
  ctx.save()
  ctx.beginPath()
  const j = s * 0.004
  const steps = 60
  const pts: [number, number][] = []
  for (let i = 0; i <= steps; i++) pts.push([L.x + (L.w * i) / steps, L.y + (rnd() - 0.5) * j])
  for (let i = 0; i <= steps; i++) pts.push([L.x + L.w + (rnd() - 0.5) * j, L.y + (L.h * i) / steps])
  for (let i = steps; i >= 0; i--) pts.push([L.x + (L.w * i) / steps, L.y + L.h + (rnd() - 0.5) * j])
  for (let i = steps; i >= 0; i--) pts.push([L.x + (rnd() - 0.5) * j, L.y + (L.h * i) / steps])
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.clip()
  ctx.drawImage(img, L.x, L.y)
  ctx.restore()
  ctx.fillStyle = amber
  ctx.font = font(s * 0.028)
  ctx.textBaseline = 'middle'
  const labelY = L.y + L.h + (L.H - L.y - L.h) / 2
  ctx.fillText('IMAGINARY 160 PRO', L.x, labelY)
  const frame = `${1 + Math.floor(rnd() * 12)}`
  const tw = ctx.measureText(frame).width
  ctx.fillText(frame, L.x + L.w - tw, labelY)
}

function mulberry(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
