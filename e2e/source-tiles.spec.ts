import { expect, test } from '@playwright/test'
import { open } from './helpers'

test('source tiles preserve fine detail across crop, rotation, flips, sharpening and aberration', async ({ page }) => {
  const errors = await open(page)
  const result = await page.evaluate(async () => {
    const rp: string = '/src/store/render.ts',
      ep: string = '/src/model/edit.ts',
      gp: string = '/src/engine/geometry.ts'
    const { requireRenderer } = await import(/* @vite-ignore */ rp)
    const { defaultEdit } = await import(/* @vite-ignore */ ep)
    const { cropPixelSize } = await import(/* @vite-ignore */ gp)
    const r = requireRenderer(),
      gl = r.gl
    const image = new OffscreenCanvas(1027, 619)
    const ctx = image.getContext('2d')!
    const px = ctx.createImageData(image.width, image.height)
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        const i = (y * image.width + x) * 4
        px.data.set([x % 2 ? 225 : 25, y % 3 ? 170 : 30, (x + y) % 5 ? 70 : 220, 255], i)
      }
    ctx.putImageData(px, 0, 0)
    const regular = r.loadSource(image)
    const proto = WebGL2RenderingContext.prototype
    const get = Object.getOwnPropertyDescriptor(proto, 'getParameter')!.value as (
      this: WebGL2RenderingContext,
      name: number,
    ) => unknown
    const results: { max: number; mean: number; dims: number[]; tiles: number }[] = []
    try {
      for (const rot of [0, 1, 2, 3]) {
        const edit = defaultEdit(1)
        edit.crop = {
          ...edit.crop,
          rot90: rot,
          flipH: rot % 2 === 1,
          flipV: rot === 2,
          x: 0.08,
          y: 0.07,
          w: 0.84,
          h: 0.86,
          straighten: rot ? 3 : 0,
        }
        edit.tools.sharpen = 0.3
        edit.fx.aberration = rot ? 0.3 : 0
        const [w, h] = cropPixelSize(edit.crop, image.width, image.height)
        const baseline: Uint8ClampedArray = await r.renderPixels(regular, edit, w, h)
        proto.getParameter = function (name) {
          return name === this.MAX_TEXTURE_SIZE ? 512 : get.call(this, name)
        }
        const tiled = r.loadExportSource(image)
        let tiles = 0
        let actual: Uint8ClampedArray
        try {
          actual = await r.renderPixels(tiled, edit, w, h, () => tiles++)
        } finally {
          r.deleteSource(tiled)
          proto.getParameter = get
        }
        let max = 0,
          sum = 0
        for (let i = 0; i < actual.length; i++) {
          const d = Math.abs(actual[i] - baseline[i])
          max = Math.max(max, d)
          sum += d
        }
        results.push({ max, mean: sum / actual.length, dims: [w, h], tiles })
      }
      return { results, glError: gl.getError() }
    } finally {
      proto.getParameter = get
      r.deleteSource(regular)
    }
  })
  expect(result.glError).toBe(0)
  for (const r of result.results) {
    expect(r.tiles).toBeGreaterThan(1)
    expect(r.mean).toBeLessThan(0.02)
    expect(r.max).toBeLessThanOrEqual(8)
  }
  expect(errors).toEqual([])
})

test('RAW source tiles retain half-float shadows and light above white in 16-bit output', async ({ page }) => {
  const errors = await open(page)
  const result = await page.evaluate(async () => {
    const rp: string = '/src/store/render.ts',
      ep: string = '/src/model/edit.ts',
      lp: string = '/src/engine/linear.ts'
    const { requireRenderer } = await import(/* @vite-ignore */ rp)
    const { defaultEdit } = await import(/* @vite-ignore */ ep)
    const { linearImage, toHalf } = await import(/* @vite-ignore */ lp)
    const r = requireRenderer(),
      w = 1031,
      h = 31,
      data = new Uint16Array(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = x < 512 ? 0.0001 + x / 5_000_000 : x % 2 ? 2 : 0.4
        data.set([toHalf(v), toHalf(v), toHalf(v), toHalf(1)], (y * w + x) * 4)
      }
    const img = linearImage(w, h, data),
      edit = defaultEdit(1)
    edit.tools.rawExposure = -1 / 3
    const full = r.loadSource(img)
    const expected: Uint16Array = await r.renderPixels16(full, edit, w, h)
    r.deleteSource(full)
    const proto = WebGL2RenderingContext.prototype
    const get = Object.getOwnPropertyDescriptor(proto, 'getParameter')!.value as (
      this: WebGL2RenderingContext,
      name: number,
    ) => unknown
    proto.getParameter = function (name) {
      return name === this.MAX_TEXTURE_SIZE ? 512 : get.call(this, name)
    }
    const tiled = r.loadExportSource(img)
    try {
      const actual: Uint16Array = await r.renderPixels16(tiled, edit, w, h)
      let max = 0,
        sum = 0,
        worst = 0
      for (let i = 0; i < actual.length; i++) {
        const d = Math.abs(actual[i] - expected[i])
        if (d > max) worst = i
        max = Math.max(max, d)
        sum += d
      }
      const shadows = new Set(Array.from({ length: 512 }, (_, x) => actual[(15 * w + x) * 3])).size
      return {
        width: tiled.width,
        height: tiled.height,
        max,
        mean: sum / actual.length,
        shadows,
        worst: [Math.floor(worst / 3) % w, Math.floor(worst / (w * 3)), expected[worst], actual[worst]],
        white: actual[(15 * w + 701) * 3],
        glError: r.gl.getError(),
      }
    } finally {
      proto.getParameter = get
      r.deleteSource(tiled)
      img.close()
    }
  })
  expect(result.glError).toBe(0)
  expect([result.width, result.height]).toEqual([1031, 31])
  expect(result.max).toBeLessThanOrEqual(8)
  expect(result.mean).toBeLessThan(1)
  expect(result.shadows).toBeGreaterThan(30)
  expect(result.white).toBeGreaterThan(65000)
  expect(errors).toEqual([])
})

test('tiled P3 export keeps its profile, effects and border; small exports use the bounded proxy', async ({ page }) => {
  const errors = await open(page)
  const result = await page.evaluate(async () => {
    const rp: string = '/src/store/render.ts',
      ep: string = '/src/store/export.ts',
      dp: string = '/src/store/db.ts',
      mp: string = '/src/model/edit.ts',
      bp: string = '/src/engine/border.ts'
    const { requireRenderer } = await import(/* @vite-ignore */ rp)
    const { renderExport } = await import(/* @vite-ignore */ ep)
    const { putBlob } = await import(/* @vite-ignore */ dp)
    const { defaultEdit } = await import(/* @vite-ignore */ mp)
    const { borderLayout } = await import(/* @vite-ignore */ bp)
    const c = new OffscreenCanvas(1025, 65),
      g = c.getContext('2d', { colorSpace: 'display-p3' })!
    g.fillStyle = 'color(display-p3 0.95 0.15 0.05)'
    g.fillRect(0, 0, 1025, 65)
    g.fillStyle = 'color(display-p3 0.05 0.85 0.2)'
    g.fillRect(510, 0, 515, 65)
    await putBlob('originals', 'p3-tiled', await c.convertToBlob())
    const edit = defaultEdit(1)
    edit.fx.grain = 0.2
    edit.fx.bloom = 0.1
    edit.fx.halation = 0.1
    edit.border = { kind: 'solid', size: 0.1, color: '#ffffff' }
    const photo = { id: 'p3-tiled', name: 'p3.png', width: 1025, height: 65, order: 0, added: 0, edit }
    const opts = { format: 'png', quality: 1, longEdge: null, space: 'display-p3' }
    const read = async (b: Blob) => {
      const bmp = await createImageBitmap(b),
        cv = new OffscreenCanvas(bmp.width, bmp.height),
        ctx = cv.getContext('2d', { colorSpace: 'display-p3' })!
      ctx.drawImage(bmp, 0, 0)
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height, { colorSpace: 'display-p3' }).data
      const dims = [bmp.width, bmp.height]
      bmp.close()
      return { dims, data }
    }
    const expected = await read(await renderExport(photo, opts))
    const proto = WebGL2RenderingContext.prototype
    const get = Object.getOwnPropertyDescriptor(proto, 'getParameter')!.value as (
      this: WebGL2RenderingContext,
      name: number,
    ) => unknown
    proto.getParameter = function (name) {
      return name === this.MAX_TEXTURE_SIZE ? 512 : get.call(this, name)
    }
    try {
      const actual = await read(await renderExport(photo, opts))
      const small = await read(
        await renderExport(
          { ...photo, edit: { ...edit, border: { ...edit.border, kind: 'none' } } },
          { ...opts, longEdge: 1 },
        ),
      )
      let sum = 0
      for (let i = 0; i < actual.data.length; i++) sum += Math.abs(actual.data[i] - expected.data[i])
      const L = borderLayout(edit.border, 1025, 65)
      const i = ((L.y + 30) * L.W + L.x + 200) * 4
      return {
        dims: actual.dims,
        expectedDims: [L.W, L.H],
        mean: sum / actual.data.length,
        small: small.dims,
        red: Array.from(actual.data.slice(i, i + 3)),
        glError: requireRenderer().gl.getError(),
      }
    } finally {
      proto.getParameter = get
    }
  })
  expect(result.dims).toEqual(result.expectedDims)
  expect(result.small).toEqual([1, 1])
  expect(result.mean).toBeLessThan(1)
  // Reading the exported PNG in P3 keeps the saturated red patch's original P3 coordinates.
  expect(result.red[0]).toBeGreaterThan(230)
  expect(result.red[1]).toBeLessThan(70)
  expect(result.glError).toBe(0)
  expect(errors).toEqual([])
})

test('downscaled source tiles use the same mip grid across different tile partitions', async ({ page }) => {
  const errors = await open(page)
  const result = await page.evaluate(async () => {
    const rp: string = '/src/store/render.ts',
      ep: string = '/src/model/edit.ts'
    const { requireRenderer } = await import(/* @vite-ignore */ rp)
    const { defaultEdit } = await import(/* @vite-ignore */ ep)
    const r = requireRenderer(),
      c = new OffscreenCanvas(2049, 529),
      g = c.getContext('2d')!,
      image = g.createImageData(c.width, c.height)
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++)
        image.data.set([x % 3 ? 210 : 20, y % 3 ? 70 : 230, (x + y) % 5 ? 50 : 190, 255], (y * c.width + x) * 4)
    g.putImageData(image, 0, 0)
    const edit = defaultEdit(1)
    edit.crop.straighten = 3
    edit.tools.sharpen = 0.2
    edit.fx.aberration = 0.4
    const proto = WebGL2RenderingContext.prototype
    const get = Object.getOwnPropertyDescriptor(proto, 'getParameter')!.value as (
      this: WebGL2RenderingContext,
      name: number,
    ) => unknown
    const images: Uint8ClampedArray[] = []
    try {
      for (const limit of [768, 512]) {
        proto.getParameter = function (name) {
          return name === this.MAX_TEXTURE_SIZE ? limit : get.call(this, name)
        }
        const src = r.loadExportSource(c)
        try {
          images.push(await r.renderPixels(src, edit, 1200, 310))
        } finally {
          r.deleteSource(src)
        }
      }
      let sum = 0,
        high = 0
      for (let i = 0; i < images[0].length; i++) {
        const d = Math.abs(images[0][i] - images[1][i])
        sum += d
        if (d > 2) high++
      }
      return { mean: sum / images[0].length, fractionOver2: high / images[0].length, glError: r.gl.getError() }
    } finally {
      proto.getParameter = get
    }
  })
  expect(result.mean).toBeLessThan(0.03)
  expect(result.fractionOver2).toBeLessThan(0.0001)
  expect(result.glError).toBe(0)
  expect(errors).toEqual([])
})

test('16-bit export retains pixels beyond the actual hardware texture width', async ({ page }) => {
  const errors = await open(page)
  const result = await page.evaluate(async () => {
    const rp: string = '/src/store/render.ts',
      ep: string = '/src/model/edit.ts',
      lp: string = '/src/engine/linear.ts'
    const { requireRenderer } = await import(/* @vite-ignore */ rp)
    const { defaultEdit } = await import(/* @vite-ignore */ ep)
    const { linearImage, toHalf } = await import(/* @vite-ignore */ lp)
    const r = requireRenderer(),
      limit = r.gl.getParameter(r.gl.MAX_TEXTURE_SIZE),
      w = limit + 17,
      h = 8
    const data = new Uint16Array(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = toHalf(x % 2 ? 0.8 : 0.05)
        data.set([v, v, v, toHalf(1)], (y * w + x) * 4)
      }
    const img = linearImage(w, h, data),
      src = r.loadExportSource(img)
    try {
      const pixels: Uint16Array = await r.renderPixels16(src, defaultEdit(1), w, h)
      const a = pixels[(3 * w + limit + 2) * 3],
        b = pixels[(3 * w + limit + 3) * 3]
      return {
        limit,
        width: src.width,
        count: pixels.length,
        expected: w * h * 3,
        difference: Math.abs(a - b),
        glError: r.gl.getError(),
      }
    } finally {
      r.deleteSource(src)
      img.close()
    }
  })
  expect(result.width).toBeGreaterThan(result.limit)
  expect(result.count).toBe(result.expected)
  expect(result.difference).toBeGreaterThan(35000)
  expect(result.glError).toBe(0)
  expect(errors).toEqual([])
})
