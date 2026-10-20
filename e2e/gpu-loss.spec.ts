import { expect, test } from '@playwright/test'
import { importFiles, open } from './helpers'

// Tests that lose the GPU context on purpose. They run in projects of their own (playwright.config.ts), so in a
// browser instance of their own. A headless Chromium that had lost a dozen contexts was seen to shut itself down a few
// seconds later; that was macOS force-quitting the headless shell (see playwright.config.ts), which the e2e projects
// no longer use, but losing contexts on purpose stays away from the other tests anyway.

test('a lost GPU context settles every read-back and export instead of leaving them pending', async ({ page }) => {
  const errors = await open(page)
  const got = await page.evaluate(async () => {
    const rendererModule: string = '/src/engine/renderer.ts'
    const presetsModule: string = '/src/model/presets.ts'
    const editModule: string = '/src/model/edit.ts'
    const { Renderer } = await import(/* @vite-ignore */ rendererModule)
    const { lookFor } = await import(/* @vite-ignore */ presetsModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    // How a promise ends: 'resolved', the error's name, or 'pending' if it has not settled within the window.
    const settle = (p: Promise<unknown>, ms = 3000) =>
      Promise.race([p.then(() => 'resolved', (e: Error) => e.name), new Promise<string>((r) => setTimeout(() => r('pending'), ms))])
    // A renderer of its own (never the app's), a photo on it, and a way to lose its context.
    const fresh = () => {
      const ren = Renderer.create(lookFor)!
      const c = new OffscreenCanvas(64, 64)
      const g = c.getContext('2d')!
      g.fillStyle = '#c84'
      g.fillRect(0, 0, 64, 64)
      return { ren, src: ren.loadSource(c.transferToImageBitmap()), lose: () => ren.gl.getExtension('WEBGL_lose_context')!.loseContext() }
    }
    // Pixel buffers still reserved by a read (a private field: what a stuck read holds on to).
    const busy = (ren: { viewPbos: { done: unknown }[] }) => ren.viewPbos.filter((p) => p.done).length
    const e = defaultEdit(1)
    const out: Record<string, unknown> = {}
    {
      // Lost while the read waits for the GPU.
      const { ren, src, lose } = fresh()
      const p = ren.renderLater(src, e, 2048, 2048, 0, 'srgb')
      lose()
      out.waiting = await settle(p)
      out.waitingBusy = busy(ren)
    }
    {
      // Both pixel buffers taken, two more reads queued behind them, one of them the loupe's region.
      const { ren, src, lose } = fresh()
      const ps = [0, 1, 2].map(() => ren.renderLater(src, e, 2048, 2048, 0, 'srgb'))
      ps.push(ren.regionLater(src, e, 2048, 2048, 0, 0, 1024, 1024, 2048, 'display-p3'))
      lose()
      out.queued = await Promise.all(ps.map((p: Promise<unknown>) => settle(p)))
      out.queuedBusy = busy(ren)
    }
    {
      // Lost as the read is queued, before its fence exists.
      const { ren, src, lose } = fresh()
      const fenceSync = ren.gl.fenceSync.bind(ren.gl)
      ren.gl.fenceSync = (condition: number, flags: number) => (lose(), fenceSync(condition, flags))
      out.beforeFence = await settle(ren.renderLater(src, e, 256, 256, 0, 'srgb'))
      out.beforeFenceBusy = busy(ren)
    }
    {
      // Already lost: renders and exports fail at once instead of handing back blank pixels.
      const { ren, src, lose } = fresh()
      lose()
      out.lost = [
        await settle(ren.renderLater(src, e, 64, 64, 0, 'srgb')),
        await settle(ren.renderPixels(src, e, 64, 64)),
        await settle((async () => ren.renderBitmap(src, e, 64, 64))()),
      ]
    }
    {
      // Lost between export tiles.
      const { ren, src, lose } = fresh()
      const p = ren.renderPixels(src, e, 4096, 4096)
      setTimeout(lose, 0)
      out.export = await settle(p, 10_000)
    }
    return out
  })
  expect(got).toEqual({
    waiting: 'ContextLostError',
    waitingBusy: 0,
    queued: ['ContextLostError', 'ContextLostError', 'ContextLostError', 'ContextLostError'],
    queuedBusy: 0,
    beforeFence: 'ContextLostError',
    beforeFenceBusy: 0,
    lost: ['ContextLostError', 'ContextLostError', 'ContextLostError'],
    export: 'ContextLostError',
  })
  expect(errors).toEqual([])
})

test('after a lost GPU context the views render again and stay editable', async ({ page }) => {
  // A P3 screen, so WebKit's views take the read-back route (renderLater, regionLater) and Chromium's the bitmaps.
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window)
    window.matchMedia = (q: string) => (q.includes('color-gamut: p3') ? ({ matches: true, media: q } as MediaQueryList) : original(q))
  })
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  await page.keyboard.press('g')
  await expect(page.locator('canvas[class*="mainCanvas"]').first()).toHaveCSS('opacity', '1')
  // A few pixels of what a view canvas shows.
  const sample = (selector: string) =>
    page.evaluate((sel) => {
      const c = document.querySelector<HTMLCanvasElement>(sel)!
      const g = new OffscreenCanvas(c.width, c.height).getContext('2d')!
      g.drawImage(c, 0, 0)
      return [0.2, 0.5, 0.8].flatMap((f) => Array.from(g.getImageData(Math.floor(c.width * f), Math.floor(c.height * f), 1, 1).data.slice(0, 3)))
    }, selector)
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3)
  const lose = () =>
    page.evaluate(() => {
      const r = (window as unknown as { __studio: { renderer(): { gl: WebGL2RenderingContext } } }).__studio.renderer()
      r.gl.getExtension('WEBGL_lose_context')!.loseContext()
    })
  const exposure = async (v: string) => {
    const field = page.getByRole('spinbutton', { name: 'Exposure', exact: true })
    await field.fill(v)
    await field.press('Enter')
  }
  await page.getByRole('button', { name: 'Tools' }).click()

  // The single view: lost, then an edit renders on a new context, and undoing it brings back the same pixels.
  const main = 'canvas[class*="mainCanvas"]'
  const before = await sample(main)
  await lose()
  await exposure('1')
  await expect.poll(async () => near(await sample(main), before), { timeout: 10_000 }).toBe(false)
  await exposure('0')
  await expect.poll(async () => near(await sample(main), before), { timeout: 10_000 }).toBe(true)

  // The 100% loupe, from the full-size original uploaded again.
  await page.keyboard.press('z')
  const loupe = 'div[class*="loupe"] canvas'
  await expect(page.getByText(/^100% ·/)).toBeVisible()
  await expect.poll(async () => (await sample(loupe)).some((v) => v > 0), { timeout: 10_000 }).toBe(true)
  const zoomed = await sample(loupe)
  await lose()
  await exposure('1')
  await expect.poll(async () => near(await sample(loupe), zoomed), { timeout: 10_000 }).toBe(false)
  await exposure('0')
  await expect.poll(async () => near(await sample(loupe), zoomed), { timeout: 10_000 }).toBe(true)

  // An export on the new renderer is the photo, not the blank pixels of a lost context.
  await page.evaluate(() => {
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (b: Blob | MediaSource) => (((window as unknown as { __out: unknown }).__out = b), create(b))
  })
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('button', { name: 'PNG' }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export 1 photo' }).click()
  await download
  const mean = await page.evaluate(async () => {
    const b = await createImageBitmap((window as unknown as { __out: Blob }).__out)
    const g = new OffscreenCanvas(b.width, b.height).getContext('2d')!
    g.drawImage(b, 0, 0)
    const d = g.getImageData(0, 0, b.width, b.height).data
    let sum = 0
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2]
    return sum / (d.length / 4) / 3
  })
  expect(mean).toBeGreaterThan(60)
  expect(errors).toEqual([])
})

test('a full-size decode that finishes late never replaces or deletes the current one', async ({ page }) => {
  const errors = await open(page)
  const got = await page.evaluate(async () => {
    const renderModule: string = '/src/store/render.ts'
    const dbModule: string = '/src/store/db.ts'
    const editModule: string = '/src/model/edit.ts'
    const m = await import(/* @vite-ignore */ renderModule)
    const db = await import(/* @vite-ignore */ dbModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const blob = await (await fetch('/e2e/fixtures/chart.jpg')).blob()
    // Decodes of the original wait behind gates opened by hand, first held first.
    const original = window.createImageBitmap.bind(window)
    const gates: (() => void)[] = []
    let hold = 0
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      if (hold > 0 && args[0] instanceof Blob && args[0].size === blob.size) {
        hold--
        await new Promise<void>((r) => gates.push(r))
      }
      return original(...args)
    }) as typeof createImageBitmap
    const until = async <T,>(f: () => T) => {
      for (let i = 0; i < 1000; i++) {
        const v = f()
        if (v) return v
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('timed out')
    }
    type R = { gl: WebGL2RenderingContext; renderPixels: (...a: unknown[]) => Promise<Uint8ClampedArray> }
    type Src = { tex: { tex: WebGLTexture } } | null
    const lose = async () => {
      const r: R = m.getRenderer()
      r.gl.getExtension('WEBGL_lose_context')!.loseContext()
      await until(() => m.getRenderer() && m.getRenderer() !== r)
    }
    // Whether a source's texture still exists, and what it renders: the chart's mean level, or black from a deleted one.
    const check = async (src: Src) => {
      const r: R = m.getRenderer()
      const px = await r.renderPixels(src, defaultEdit(1), 64, 64)
      let sum = 0
      for (let i = 0; i < px.length; i += 4) sum += px[i] + px[i + 1] + px[i + 2]
      return { texture: r.gl.isTexture(src!.tex.tex), mean: Math.round(sum / (px.length / 4) / 3), error: r.gl.getError() }
    }
    // What a superseded request handed back: nothing, or a source it published.
    const was = (s: Src) => (s === null ? null : 'published')
    // A request whose decode is held (wrapped: an async function returning the promise itself would wait for it).
    const held = async (id: string) => {
      hold = 1
      const p: Promise<Src> = m.fullSource(id)
      await until(() => gates.length)
      return { p }
    }
    const ids = ['late-a', 'late-b']
    for (const id of ids) await db.putBlob('originals', id, blob)
    const out: Record<string, unknown> = {}
    try {
      // Lost while decoding; the replacement finishes first, then the old decode.
      m.releaseFull()
      let old = await held('late-a')
      await lose()
      let fresh: Src = await m.fullSource('late-a')
      const before = await check(fresh)
      gates.shift()!()
      out.replacementFirst = { late: was(await old.p), before, after: await check(fresh) }
      // Lost while decoding; the old decode finishes before the replacement is asked for.
      m.releaseFull()
      old = await held('late-a')
      await lose()
      gates.shift()!()
      const late = await old.p
      fresh = await m.fullSource('late-a')
      out.oldFirst = { late: was(late), after: await check(fresh) }
      // Lost twice while decoding.
      m.releaseFull()
      old = await held('late-a')
      await lose()
      await lose()
      fresh = await m.fullSource('late-a')
      gates.shift()!()
      out.lostTwice = { late: was(await old.p), after: await check(fresh) }
      // Another photo while decoding: it stays the current one.
      m.releaseFull()
      old = await held('late-a')
      const b: Src = await m.fullSource('late-b')
      gates.shift()!()
      out.switched = { late: was(await old.p), after: await check(b), current: (await m.fullSource('late-b')) === b }
      // The loupe closed while decoding: nothing is kept.
      m.releaseFull()
      old = await held('late-a')
      m.releaseFull()
      gates.shift()!()
      out.closed = { late: was(await old.p) }
      // Back to the loaded photo while another one decodes: the late decode must not delete it.
      m.releaseFull()
      const a: Src = await m.fullSource('late-a')
      old = await held('late-b')
      const again: Src = await m.fullSource('late-a')
      gates.shift()!()
      out.backToLoaded = { same: again === a, late: was(await old.p), after: await check(a), current: (await m.fullSource('late-a')) === a }
    } finally {
      gates.forEach((g) => g())
      window.createImageBitmap = original
      m.releaseFull()
      await db.deletePhotos(ids)
    }
    return out
  })
  // A superseded decode publishes nothing; the current source keeps its texture and renders the chart.
  const fine = { texture: true, mean: expect.any(Number), error: 0 }
  expect(got).toEqual({
    replacementFirst: { late: null, before: fine, after: fine },
    oldFirst: { late: null, after: fine },
    lostTwice: { late: null, after: fine },
    switched: { late: null, after: fine, current: true },
    closed: { late: null },
    backToLoaded: { same: true, late: null, after: fine, current: true },
  })
  const r = got.replacementFirst as { before: { mean: number }; after: { mean: number } }
  expect(r.before.mean).toBeGreaterThan(60)
  expect(r.after.mean).toBe(r.before.mean)
  expect(errors).toEqual([])
})

test('the loupe still shows and edits the photo when its context is lost while the original decodes', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window)
    window.matchMedia = (q: string) => (q.includes('color-gamut: p3') ? ({ matches: true, media: q } as MediaQueryList) : original(q))
  })
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  await page.keyboard.press('g')
  await expect(page.locator('canvas[class*="mainCanvas"]').first()).toHaveCSS('opacity', '1')
  await page.getByRole('button', { name: 'Tools' }).click()
  // The next decode of the original waits until released.
  type W = { __release?: () => void; __decoded?: boolean }
  await page.evaluate(async () => {
    const size = (await (await fetch('/e2e/fixtures/chart.jpg')).blob()).size
    const original = window.createImageBitmap.bind(window)
    const w = window as unknown as W
    let held = false
    window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      if (held || !(args[0] instanceof Blob) || args[0].size !== size) return original(...args)
      held = true
      await new Promise<void>((r) => (w.__release = r))
      const out = await original(...args)
      w.__decoded = true
      return out
    }) as typeof createImageBitmap
  })
  const loupe = 'div[class*="loupe"] canvas'
  const sample = () =>
    page.evaluate((sel) => {
      const c = document.querySelector<HTMLCanvasElement>(sel)
      if (!c || !c.width) return [0, 0, 0]
      const g = new OffscreenCanvas(c.width, c.height).getContext('2d')!
      g.drawImage(c, 0, 0)
      return [0.3, 0.5, 0.7].flatMap((f) => Array.from(g.getImageData(Math.floor(c.width * f), Math.floor(c.height * f), 1, 1).data.slice(0, 3)))
    }, loupe)
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3)
  const exposure = async (v: string) => {
    const field = page.getByRole('spinbutton', { name: 'Exposure', exact: true })
    await field.fill(v)
    await field.press('Enter')
  }
  // 100%: the original's decode is held; the context goes; the loupe asks again and shows the photo.
  await page.keyboard.press('z')
  await expect.poll(() => page.evaluate(() => !!(window as unknown as W).__release)).toBe(true)
  await page.evaluate(() => (window as unknown as { __studio: { renderer(): { gl: WebGL2RenderingContext } } }).__studio.renderer().gl.getExtension('WEBGL_lose_context')!.loseContext())
  await expect.poll(async () => (await sample()).some((v) => v > 0), { timeout: 10_000 }).toBe(true)
  const shown = await sample()
  // The first decode finishes last; the loupe keeps working on what it shows.
  await page.evaluate(() => (window as unknown as W).__release!())
  await expect.poll(() => page.evaluate(() => !!(window as unknown as W).__decoded)).toBe(true)
  await exposure('1')
  await expect.poll(async () => near(await sample(), shown), { timeout: 10_000 }).toBe(false)
  await exposure('0')
  await expect.poll(async () => near(await sample(), shown), { timeout: 10_000 }).toBe(true)
  expect(errors).toEqual([])
})
