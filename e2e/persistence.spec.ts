import { expect, test } from '@playwright/test'
import { importFiles, open } from './helpers'

type Lib = {
  getState(): {
    ready: boolean
    photos: { id: string; name: string; favorite?: boolean; edit: { tools: Record<string, number> } }[]
    select(id: string): void
    updateEdits(fn: (e: { tools: Record<string, number> }) => unknown, label?: string): void
    toggleFavorite(): void
    removeSelected(): void
  }
}
const state = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    (window as unknown as { __studio: { lib: Lib } }).__studio.lib
      .getState()
      .photos.map((p) => ({ name: p.name, exposure: p.edit.tools.exposure, favorite: !!p.favorite })),
  )

test('edits, a favorite and a removal made right before a reload are all there after it', async ({ page }) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg', 'p3.png')
  // The import's own records are written by now; everything below happens inside the 400 ms write delay.
  await page.waitForTimeout(800)
  await page.evaluate(() => {
    const lib = (window as unknown as { __studio: { lib: Lib } }).__studio.lib
    const L = () => lib.getState()
    const [a, b] = L().photos
    L().select(a.id)
    // Several writes in a row: the newest must win.
    for (const v of [0.1, 0.2, 0.3, 0.5]) L().updateEdits((e) => ({ ...e, tools: { ...e.tools, exposure: v } }), 'Exposure')
    L().toggleFavorite()
    L().select(b.id)
    L().removeSelected()
    // Marks this page, so the checks below run on the reloaded one.
    ;(window as unknown as { __old?: boolean }).__old = true
    location.reload()
  })
  await page.waitForFunction(() => {
    const w = window as unknown as { __old?: boolean; __studio?: { lib: Lib } }
    return !w.__old && w.__studio?.lib.getState().ready
  })
  expect(await state(page)).toEqual([{ name: 'chart.jpg', exposure: 0.5, favorite: true }])
  // And in IndexedDB itself, not only in what the page restored.
  const stored = await page.evaluate(async () => {
    const dbModule: string = '/src/store/db.ts'
    const db = await import(/* @vite-ignore */ dbModule)
    await db.flushPhotos?.()
    return (await db.loadAll()).map((p: { name: string; favorite?: boolean; edit: { tools: Record<string, number> } }) => [p.name, p.edit.tools.exposure, !!p.favorite])
  })
  expect(stored).toEqual([['chart.jpg', 0.5, true]])
  expect(errors).toEqual([])
})
