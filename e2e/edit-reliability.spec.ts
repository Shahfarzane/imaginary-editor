import { expect, test } from '@playwright/test'
import { importFiles, open } from './helpers'

// The following persistence probes write records directly. Let import's background metadata write finish first.
const importsSettled = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => {
    const photos = (
      window as unknown as { __studio: { lib: { getState(): { photos: { info?: unknown }[] } } } }
    ).__studio.lib.getState().photos
    return photos.length > 0 && photos.every((p) => p.info !== undefined)
  })

test('Escape discards a typed slider value without adding history', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  const exposure = page.getByRole('spinbutton', { name: 'Exposure', exact: true })
  await exposure.fill('3')
  await exposure.press('Escape')
  await expect(exposure).toHaveValue('0')
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
  await exposure.fill('2')
  await exposure.press('Enter')
  await expect(exposure).toHaveValue('2')
  await page.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(exposure).toHaveValue('0')
  expect(errors).toEqual([])
})

test('saving in another tab cannot discard a pending photo edit', async ({ page, context }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg', 'p3.png')
  await importsSettled(page)
  const other = await context.newPage()
  await other.goto('/')
  await other.waitForFunction(
    () =>
      (window as unknown as { __studio?: { lib: { getState(): { ready: boolean } } } }).__studio?.lib.getState().ready,
  )
  // Flush import metadata first, then hold only the deferred edit timers. Both tabs use the same database.
  for (const tab of [page, other]) {
    await tab.evaluate(async () => {
      const path: string = '/src/store/db.ts'
      const d = await import(/* @vite-ignore */ path)
      await d.flushPhotos()
      const real = window.setTimeout.bind(window)
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
        real(fn, ms === 400 ? 60_000 : ms, ...args)) as typeof window.setTimeout
    })
  }
  const change = async (tab: typeof page, name: string, exposure: number) =>
    tab.evaluate(
      async ({ name, exposure }) => {
        const path: string = '/src/store/db.ts'
        const d = await import(/* @vite-ignore */ path)
        const p = (await (await d.db()).getAll('photos')).find((p: { name: string }) => p.name === name)
        d.putPhotoLater({ ...p, edit: { ...p.edit, tools: { ...p.edit.tools, exposure } } })
      },
      { name, exposure },
    )
  await change(page, 'chart.jpg', 0.5)
  await change(other, 'p3.png', 0.75)
  const got = await other.evaluate(async () => {
    const path: string = '/src/store/db.ts'
    const d = await import(/* @vite-ignore */ path)
    await d.flushPhotos()
    const saved = (await (await d.db()).getAll('photos')).find((p: { name: string }) => p.name === 'chart.jpg')
    const journals = Object.keys(localStorage)
      .filter((k) => k.startsWith('imaginary.pending-photos'))
      .map((k) => localStorage.getItem(k)!)
      .join('')
    return { saved: saved.edit.tools.exposure, journalKeepsEdit: journals.includes('"exposure":0.5') }
  })
  expect(got.saved === 0.5 || got.journalKeepsEdit).toBe(true)
  const recovered = await other.evaluate(async () => {
    const path: string = '/src/store/db.ts'
    const d = await import(/* @vite-ignore */ path)
    return (await d.loadAll()).map((p: { name: string; edit: { tools: { exposure: number } } }) => [
      p.name,
      p.edit.tools.exposure,
    ])
  })
  expect(recovered).toEqual([
    ['chart.jpg', 0.5],
    ['p3.png', 0.75],
  ])
  // The first tab still holds its edit in memory. A later flush must not recreate a photo deleted in the other tab.
  await other.evaluate(async () => {
    const path: string = '/src/store/db.ts'
    const d = await import(/* @vite-ignore */ path)
    const p = (await (await d.db()).getAll('photos')).find((p: { name: string }) => p.name === 'chart.jpg')
    await d.deletePhotos([p.id])
  })
  const remaining = await page.evaluate(async () => {
    const path: string = '/src/store/db.ts'
    const d = await import(/* @vite-ignore */ path)
    await d.flushPhotos()
    return (await d.loadAll()).map((p: { name: string }) => p.name)
  })
  expect(remaining).toEqual(['p3.png'])
  await other.close()
  expect(errors).toEqual([])
})

test('a failed removal is retried by the next flush', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  await importsSettled(page)
  const result = await page.evaluate(async () => {
    const path: string = '/src/store/db.ts'
    const d = await import(/* @vite-ignore */ path)
    await d.flushPhotos()
    const database = await d.db()
    const [photo] = await database.getAll('photos')
    const transaction = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'transaction')!
      .value as typeof IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = () => {
      throw new Error('Controlled write failure')
    }
    let rejected = false
    try {
      await d.deletePhotos([photo.id])
    } catch {
      rejected = true
    } finally {
      IDBDatabase.prototype.transaction = transaction
    }
    const before = await database.count('photos')
    await d.flushPhotos()
    const counts = await Promise.all(['photos', 'originals', 'thumbSources', 'thumbs'].map((s) => database.count(s)))
    return { rejected, before, counts }
  })
  expect(result).toEqual({ rejected: true, before: 1, counts: [0, 0, 0, 0] })
  expect(errors).toEqual([])
})

test('recovery keeps a newer journal written while it replays an older snapshot', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  await importsSettled(page)
  const result = await page.evaluate(async () => {
    const path: string = '/src/store/db.ts'
    const d = await import(/* @vite-ignore */ path)
    await d.flushPhotos()
    const [p] = await (await d.db()).getAll('photos')
    const key = 'imaginary.pending-photos' // A pending edit from the previous version also recovers.
    const entry = (exposure: number) =>
      JSON.stringify({ put: { [p.id]: { ...p, edit: { ...p.edit, tools: { ...p.edit.tools, exposure } } } }, del: [] })
    localStorage.setItem(key, entry(0.25))
    const get = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, 'get')!
      .value as typeof IDBObjectStore.prototype.get
    let wrote = false
    IDBObjectStore.prototype.get = function (query) {
      if (this.name === 'photos' && query === p.id && !wrote) {
        wrote = true
        localStorage.setItem(key, entry(0.75))
      }
      return get.call(this, query)
    }
    let first: number
    try {
      first = (await d.loadAll())[0].edit.tools.exposure
    } finally {
      IDBObjectStore.prototype.get = get
    }
    const keptNewer = localStorage.getItem(key) === entry(0.75)
    const second = (await d.loadAll())[0].edit.tools.exposure
    return { first, keptNewer, second, cleared: localStorage.getItem(key) === null }
  })
  expect(result).toEqual({ first: 0.25, keptNewer: true, second: 0.75, cleared: true })
  expect(errors).toEqual([])
})

test('export releases the decoded image when the GPU upload fails', async ({ page }) => {
  const errors = await open(page)
  const result = await page.evaluate(async () => {
    const renderPath: string = '/src/store/render.ts'
    const exportPath: string = '/src/store/export.ts'
    const dbPath: string = '/src/store/db.ts'
    const editPath: string = '/src/model/edit.ts'
    const { requireRenderer } = await import(/* @vite-ignore */ renderPath)
    const { renderExport } = await import(/* @vite-ignore */ exportPath)
    const { putBlob } = await import(/* @vite-ignore */ dbPath)
    const { defaultEdit } = await import(/* @vite-ignore */ editPath)
    const canvas = new OffscreenCanvas(16, 16)
    canvas.getContext('2d')!.fillRect(0, 0, 16, 16)
    await putBlob('originals', 'upload-failure', await canvas.convertToBlob())
    const ren = requireRenderer()
    const load = ren.loadSource
    let decoded: ImageBitmap | undefined
    ren.loadSource = (bmp: ImageBitmap) => {
      decoded = bmp
      throw new Error('Controlled upload failure')
    }
    let message = ''
    try {
      await renderExport(
        { id: 'upload-failure', name: 'image.png', width: 16, height: 16, added: 0, order: 0, edit: defaultEdit(1) },
        { format: 'png', quality: 1, longEdge: null },
      )
    } catch (error) {
      message = (error as Error).message
    } finally {
      ren.loadSource = load
    }
    return { message, width: decoded?.width, height: decoded?.height }
  })
  expect(result).toEqual({ message: 'Controlled upload failure', width: 0, height: 0 })
  expect(errors).toEqual([])
})
