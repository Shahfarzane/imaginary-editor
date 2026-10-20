// Writes p3.png: eight 32 px patches painted in a Display P3 canvas and encoded by Chromium, which embeds its own
// Display P3 profile. Five colors sit inside sRGB (so every browser's conversion agrees on them) and three only in
// P3: one with negative sRGB components, two with a component above 1 at less than white (bright saturated).
// Run from the repo root: node e2e/fixtures/make_p3.mjs
import { writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
const b64 = await page.evaluate(async () => {
  const c = new OffscreenCanvas(128, 64)
  const g = c.getContext('2d', { colorSpace: 'display-p3' })
  const patches = [
    'color(srgb 1 0 0)',
    'color(srgb 0.2 0.7 0.3)',
    'color(srgb 0.9 0.6 0.1)',
    'color(srgb 0.15 0.35 0.85)',
    'color(srgb 0.5 0.5 0.5)',
    'color(display-p3 0 1 0)',
    'color(display-p3 1 0.6 0.3)',
    'color(display-p3 0.95 0.25 0.55)',
  ]
  patches.forEach((p, i) => {
    g.fillStyle = p
    g.fillRect((i % 4) * 32, Math.floor(i / 4) * 32, 32, 32)
  })
  const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer())
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
})
writeFileSync(new URL('p3.png', import.meta.url), Buffer.from(b64, 'base64'))
await browser.close()
