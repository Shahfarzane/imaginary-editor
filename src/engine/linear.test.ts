import { describe, expect, it } from 'vite-plus/test'
import { downsampleLinear, halfTable, linearImage, linearToImageData, spans, toHalf } from './linear'

// Node has no ImageData; linearToImageData only needs its width, height and data.
class NodeImageData {
  data: Uint8ClampedArray
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8ClampedArray(width * height * 4)
  }
}
if (!('ImageData' in globalThis)) Object.assign(globalThis, { ImageData: NodeImageData })

describe('half floats', () => {
  it('round trips 0..1 within half precision, subnormals included', () => {
    const half = halfTable()
    expect(half[toHalf(0)]).toBe(0)
    expect(half[toHalf(1)]).toBe(1)
    expect(half[toHalf(0.5)]).toBe(0.5)
    for (let i = 0; i <= 4000; i++) {
      const v = (i / 4000) ** 3
      const back = half[toHalf(v)]
      // 10 mantissa bits: half a step is 2^-11 of the value; below 2^-14 the step is a fixed 2^-24.
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(v * 2 ** -11, 2 ** -25) * 1.0001)
    }
  })
})

describe('area resampling', () => {
  it('gives every output a total weight of one', () => {
    for (const [n, N] of [[10, 10], [10, 3], [4032, 2560], [7, 2]]) {
      const { to, w0, w1 } = spans(n, N)
      const sum = new Float64Array(N)
      for (let i = 0; i < n; i++) {
        sum[to[i]] += w0[i]
        if (w1[i]) sum[to[i] + 1] += w1[i]
      }
      for (const s of sum) expect(s).toBeCloseTo(1, 6)
    }
  })

  it('averages in linear light before encoding to 8-bit sRGB', () => {
    // Black and white pixels average to linear 0.5, which is sRGB 188, not 128.
    const data = new Uint16Array([toHalf(0), toHalf(0), toHalf(0), toHalf(1), toHalf(1), toHalf(1), toHalf(1), toHalf(1)])
    const out = linearToImageData(linearImage(2, 1, data), 1)
    expect([out.width, out.height]).toEqual([1, 1])
    expect(out.data[0]).toBe(188)
  })
})

describe('downsampleLinear', () => {
  it('keeps light above white and averages in linear light', () => {
    const half = halfTable()
    // 4 x 2 at twice white, the right half at 4x in red: down to 2 x 1.
    const data = new Uint16Array(4 * 2 * 4)
    for (let i = 0; i < 8; i++) data.set([toHalf(i % 4 >= 2 ? 4 : 2), toHalf(2), toHalf(2), toHalf(1)], i * 4)
    const out = downsampleLinear(linearImage(4, 2, data), 2)
    expect([out.width, out.height]).toEqual([2, 1])
    expect(Array.from(out.data, (h) => half[h])).toEqual([2, 2, 2, 1, 4, 2, 2, 1])
  })
  it('leaves an image that fits as it is', () => {
    const img = linearImage(2, 1, new Uint16Array(8))
    expect(downsampleLinear(img, 2)).toBe(img)
  })
})
