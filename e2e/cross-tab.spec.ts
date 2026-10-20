import { expect, test, type Page } from '@playwright/test'
import { importFiles, open } from './helpers'

const flush = (page: Page) =>
  page.evaluate(async () => {
    const path: string = '/src/store/db.ts'
    await (await import(/* @vite-ignore */ path)).flushPhotos()
  })
const values = (page: Page) =>
  page.evaluate(async () => {
    const path: string = '/src/store/library.ts'
    const L = (await import(/* @vite-ignore */ path)).useLibrary.getState()
    return L.photos.map((p: { edit: { tools: { exposure: number; contrast: number } }; favorite?: boolean }) => [
      p.edit.tools.exposure,
      p.edit.tools.contrast,
      !!p.favorite,
    ])
  })
const edit = (page: Page, exposure: number | null, contrast: number | null, favorite = false) =>
  page.evaluate(
    async ({ exposure, contrast, favorite }) => {
      const path: string = '/src/store/library.ts'
      const lib = (await import(/* @vite-ignore */ path)).useLibrary
      lib.getState().select(lib.getState().photos[0].id)
      lib
        .getState()
        .updateEdits(
          (e: { tools: { exposure: number; contrast: number } }) => ({
            ...e,
            tools: {
              ...e.tools,
              ...(exposure === null ? {} : { exposure }),
              ...(contrast === null ? {} : { contrast }),
            },
          }),
          'Test',
        )
      if (favorite) lib.getState().toggleFavorite()
    },
    { exposure, contrast, favorite },
  )

test('same-photo changes merge, latest field wins despite reversed flush order, and other tabs update live', async ({
  page,
  context,
}) => {
  const errors = await open(page)
  await importFiles(page, 'chart.jpg')
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __studio: { lib: { getState(): { photos: { info?: unknown }[] } } } }
      ).__studio.lib.getState().photos[0]?.info,
  )
  await flush(page)
  const other = await context.newPage()
  await other.goto('/')
  await expect.poll(() => values(other)).toEqual([[0, 0, false]])
  for (const tab of [page, other])
    await tab.evaluate(() => {
      const real = window.setTimeout.bind(window)
      window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) =>
        real(fn, ms === 400 ? 60_000 : ms, ...args)) as typeof window.setTimeout
    })
  await edit(page, 0.2, null)
  await edit(other, null, 0.4, true)
  await flush(other)
  await flush(page)
  for (const tab of [page, other]) await expect.poll(() => values(tab)).toEqual([[0.2, 0.4, true]])
  await edit(page, 0.3, null)
  await edit(other, 0.8, null)
  // The older edit lands last. Its operation stamp must prevent a rollback.
  await flush(other)
  await flush(page)
  for (const tab of [page, other]) await expect.poll(() => values(tab)).toEqual([[0.8, 0.4, true]])
  await other.reload()
  await expect.poll(() => values(other)).toEqual([[0.8, 0.4, true]])
  await edit(page, 0.1, null)
  await other.evaluate(async () => {
    const path: string = '/src/store/library.ts'
    const L = (await import(/* @vite-ignore */ path)).useLibrary.getState()
    L.selectAll()
    L.removeSelected()
  })
  await flush(other)
  await flush(page)
  for (const tab of [page, other]) await expect.poll(() => values(tab)).toEqual([])
  await other.close()
  expect(errors).toEqual([])
})
