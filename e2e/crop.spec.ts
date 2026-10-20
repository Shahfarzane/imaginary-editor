import { expect, test, type Page } from '@playwright/test'
import { importFiles, open } from './helpers'

type Lib = { getState(): { photos: { id: string; name: string }[]; selected: string[]; select(id: string): void } }

// The crop view's canvas, sampled at its center: what the view shows, not just which photo is selected.
const center = (page: Page) =>
  page.evaluate(() => {
    const c = [...document.querySelectorAll('canvas')].filter((x) => x.getBoundingClientRect().width > 50).sort((a, b) => b.width * b.height - a.width * a.height)[0]
    if (!c || !c.width) return null
    const t = new OffscreenCanvas(1, 1)
    const g = t.getContext('2d')!
    g.drawImage(c, Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1, 0, 0, 1, 1)
    return Array.from(g.getImageData(0, 0, 1, 1).data.slice(0, 3))
  })
const dominant = (px: number[] | null) => (px ? ['red', 'green', 'blue'][px.indexOf(Math.max(...px))] : null)
const selectedName = (page: Page) =>
  page.evaluate(() => {
    const st = (window as unknown as { __studio: { lib: Lib } }).__studio.lib.getState()
    return st.photos.find((p) => p.id === st.selected[0])?.name
  })

test('crop mode shows the photo it crops after the selection moves, cached or not', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'red-wide.png', 'blue-wide.png', 'green-tall.png')
  await page.evaluate(() => {
    const L = (window as unknown as { __studio: { lib: Lib } }).__studio.lib.getState()
    L.select(L.photos.find((p) => p.name === 'red-wide.png')!.id)
  })
  await page.getByRole('button', { name: 'Adjust' }).click()
  await expect.poll(async () => dominant(await center(page))).toBe('red')
  // Next photo, not yet decoded for the view: its own pixels, without another edit.
  await page.keyboard.press('ArrowRight')
  expect(await selectedName(page)).toBe('blue-wide.png')
  await expect.poll(async () => dominant(await center(page))).toBe('blue')
  // Quickly on to a third photo of another shape, and back to a cached one.
  await page.keyboard.press('ArrowRight')
  expect(await selectedName(page)).toBe('green-tall.png')
  await expect.poll(async () => dominant(await center(page))).toBe('green')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  expect(await selectedName(page)).toBe('red-wide.png')
  await expect.poll(async () => dominant(await center(page))).toBe('red')
  expect(errors).toEqual([])
})

test('a photo decoded late never paints over the one crop mode moved on to', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'red-wide.png', 'green-tall.png', 'blue-wide.png')
  // The green photo's decode waits behind a gate opened by hand.
  await page.evaluate(() => {
    const original = window.createImageBitmap.bind(window)
    const w = window as unknown as { __hold: number; __gates: (() => void)[] }
    w.__hold = 0
    w.__gates = []
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      if (w.__hold > 0 && args[0] instanceof Blob && args[0].size === 1090) {
        w.__hold--
        await new Promise<void>((r) => w.__gates.push(r))
      }
      return original(...args)
    }) as typeof createImageBitmap
    const L = (window as unknown as { __studio: { lib: Lib } }).__studio.lib.getState()
    L.select(L.photos.find((p) => p.name === 'red-wide.png')!.id)
  })
  await page.getByRole('button', { name: 'Adjust' }).click()
  await expect.poll(async () => dominant(await center(page))).toBe('red')
  await page.evaluate(() => ((window as unknown as { __hold: number }).__hold = 1))
  await page.keyboard.press('ArrowRight')
  expect(await selectedName(page)).toBe('green-tall.png')
  await expect.poll(() => page.evaluate(() => (window as unknown as { __gates: unknown[] }).__gates.length)).toBe(1)
  await page.keyboard.press('ArrowRight')
  expect(await selectedName(page)).toBe('blue-wide.png')
  await expect.poll(async () => dominant(await center(page))).toBe('blue')
  // The held decode finishes now: the view stays on blue.
  await page.evaluate(() => (window as unknown as { __gates: (() => void)[] }).__gates.forEach((g) => g()))
  await page.waitForTimeout(500)
  expect(dominant(await center(page))).toBe('blue')
  expect(errors).toEqual([])
})

type Crop = { x: number; y: number; w: number; h: number; aspect: string; rot90: number; straighten: number }
type Lib2 = { getState(): { photos: { id: string; name: string; width: number; height: number; edit: { crop: Crop } }[]; select(id: string, mode?: string): void; undo(): void } }

test('crop settings fit each selected photo by its own size, and a drag crops only the photo in view', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'red-wide.png', 'green-tall.png')
  // Both selected, the wide one active (in view).
  await page.evaluate(() => {
    const L = (window as unknown as { __studio: { lib: Lib2 } }).__studio.lib.getState()
    L.select(L.photos.find((p) => p.name === 'green-tall.png')!.id)
    L.select(L.photos.find((p) => p.name === 'red-wide.png')!.id, 'toggle')
  })
  await page.getByRole('button', { name: 'Adjust' }).click()
  // Each photo's crop in pixels of its oriented image: the ratio, and whether it stays inside the (straightened) image.
  const crops = () =>
    page.evaluate(async () => {
      const geometry: string = '/src/engine/geometry.ts'
      const cropModule: string = '/src/model/crop.ts'
      const { orientedSize } = await import(/* @vite-ignore */ geometry)
      const { cropInside } = await import(/* @vite-ignore */ cropModule)
      const ps = (window as unknown as { __studio: { lib: Lib2 } }).__studio.lib.getState().photos
      return Object.fromEntries(
        ps.map((p) => {
          const c = p.edit.crop
          const [ow, oh] = orientedSize(p.width, p.height, c.rot90)
          return [p.name, { aspect: c.aspect, ratio: +((c.w * ow) / (c.h * oh)).toFixed(3), inside: cropInside(c, p.width, p.height), x: +c.x.toFixed(4), y: +c.y.toFixed(4) }]
        }),
      )
    })
  await page.getByRole('button', { name: '4:5' }).click()
  let c = await crops()
  expect([c['red-wide.png'].ratio, c['green-tall.png'].ratio]).toEqual([0.8, 0.8])
  // A quarter turn, then a ratio of one's own.
  await page.getByRole('button', { name: 'Rotate right' }).click()
  const custom = page.getByPlaceholder('Enter custom')
  await custom.fill('7:5')
  await custom.press('Enter')
  c = await crops()
  expect([c['red-wide.png'].ratio, c['green-tall.png'].ratio]).toEqual([1.4, 1.4])
  expect([c['red-wide.png'].aspect, c['green-tall.png'].aspect]).toEqual(['7:5', '7:5'])
  // Straighten keeps every crop inside its own photo, at its ratio.
  const straighten = page.getByRole('spinbutton', { name: 'Straighten', exact: true })
  await straighten.fill('10')
  await straighten.press('Enter')
  c = await crops()
  for (const name of ['red-wide.png', 'green-tall.png']) {
    expect(c[name].inside, name).toBe(true)
    expect(Math.abs(c[name].ratio - 1.4), name).toBeLessThan(0.01)
  }
  // Undo takes both back.
  await page.evaluate(() => (window as unknown as { __studio: { lib: Lib2 } }).__studio.lib.getState().undo())
  c = await crops()
  expect([c['red-wide.png'].ratio, c['green-tall.png'].ratio]).toEqual([1.4, 1.4])
  // A drag on the crop box moves the crop of the photo in view; the other photo keeps its own.
  const before = await crops()
  const box = await page.evaluate(() => {
    const cv = [...document.querySelectorAll('canvas')].filter((x) => x.getBoundingClientRect().width > 50)[0].getBoundingClientRect()
    return { x: cv.x + cv.width / 2, y: cv.y + cv.height / 2 }
  })
  await page.mouse.move(box.x, box.y)
  await page.mouse.down()
  await page.mouse.move(box.x - 30, box.y - 30, { steps: 5 })
  await page.mouse.up()
  const after = await crops()
  expect(after['red-wide.png']).not.toEqual(before['red-wide.png'])
  expect(after['green-tall.png']).toEqual(before['green-tall.png'])
  expect(errors).toEqual([])
})
