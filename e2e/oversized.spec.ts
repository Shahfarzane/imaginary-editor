import { expect, test } from '@playwright/test'
import { open } from './helpers'

// A GPU texture limit of 512, set for the page, so sources just below, at and above it stay small.
const LIMIT = 512

test('a source larger than the GPU keeps RAW headroom, and Full export retains its original dimensions', async ({
  page,
}) => {
  const errors = await open(page)
  const got = await page.evaluate(async (limit) => {
    const proto = WebGL2RenderingContext.prototype
    const real = Object.getOwnPropertyDescriptor(proto, 'getParameter')!.value as (
      this: WebGL2RenderingContext,
      p: number,
    ) => unknown
    proto.getParameter = function (this: WebGL2RenderingContext, p: number) {
      return p === this.MAX_TEXTURE_SIZE ? limit : real.call(this, p)
    }
    const renderModule: string = '/src/store/render.ts'
    const editModule: string = '/src/model/edit.ts'
    const linearModule: string = '/src/engine/linear.ts'
    const exportModule: string = '/src/store/export.ts'
    const dbModule: string = '/src/store/db.ts'
    const libraryModule: string = '/src/store/library.ts'
    const r = await import(/* @vite-ignore */ renderModule)
    const { defaultEdit } = await import(/* @vite-ignore */ editModule)
    const { linearImage, toHalf } = await import(/* @vite-ignore */ linearModule)
    const { renderExport } = await import(/* @vite-ignore */ exportModule)
    const db = await import(/* @vite-ignore */ dbModule)
    const { useLibrary } = await import(/* @vite-ignore */ libraryModule)
    const ren = r.getRenderer()
    // Gray at twice white in linear light (RAW), one stop down: white, whether the GPU took it whole or not.
    const raw: Record<number, { headroom: boolean; width: number; center: number }> = {}
    for (const w of [limit - 8, limit, limit + 64]) {
      const data = new Uint16Array(w * 8 * 4)
      for (let i = 0; i < w * 8; i++) data.set([toHalf(2), toHalf(2), toHalf(2), toHalf(1)], i * 4)
      const src = ren.loadSource(linearImage(w, 8, data))
      const e = defaultEdit(1)
      e.tools.rawExposure = -1 / 3
      const px: Uint16Array = await ren.renderPixels16(src, e, 64, 8)
      raw[w] = { headroom: src.headroom, width: src.width, center: px[(4 * 64 + 32) * 3] }
      ren.deleteSource(src)
    }
    // Full export uploads source regions, so the file keeps the original dimensions.
    const c = new OffscreenCanvas(limit + 64, 8)
    c.getContext('2d')!.fillRect(0, 0, limit + 64, 8)
    const blob = await c.convertToBlob({ type: 'image/png' })
    await db.putBlob('originals', 'oversized', blob)
    const photo = {
      id: 'oversized',
      name: 'wide.png',
      width: limit + 64,
      height: 8,
      added: 0,
      order: 0,
      edit: defaultEdit(1),
    }
    const toasts = () => useLibrary.getState().toasts.map((t: { text: string }) => t.text)
    const before = toasts().length
    const out = await renderExport(photo, { format: 'png', quality: 1, longEdge: null })
    const v = new DataView(await out.slice(16, 24).arrayBuffer())
    await db.deletePhotos(['oversized'])
    proto.getParameter = real
    return { raw, file: [v.getUint32(0), v.getUint32(4)], notice: toasts().slice(before), error: ren.gl.getError() }
  }, LIMIT)
  expect(got.error).toBe(0)
  for (const [w, v] of Object.entries(got.raw)) {
    expect(v.headroom, w).toBe(true)
    expect(v.center, w).toBeGreaterThan(65000)
  }
  expect(got.raw[LIMIT + 64].width).toBe(LIMIT)
  expect(got.file).toEqual([LIMIT + 64, 8])
  expect(got.notice).toHaveLength(0)
  expect(errors).toEqual([])
})
