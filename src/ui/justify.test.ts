import { describe, expect, it } from 'vite-plus/test'
import { justify } from './justify'

describe('justified grid rows', () => {
  const aspects = [1.5, 0.667, 1.778, 1, 0.75, 1.5, 1.5, 0.5625, 1.333, 1]

  it('fills every row but the last edge to edge', () => {
    const rows = justify(aspects, 1000, 200, 20)
    for (const r of rows.slice(0, -1)) expect(r.widths.reduce((a, b) => a + b, 0) + 20 * (r.items.length - 1)).toBe(1000)
    expect(rows.flatMap((r) => r.items)).toEqual(aspects.map((_, i) => i))
  })

  it('keeps each photo at its aspect ratio', () => {
    for (const r of justify(aspects, 1000, 200, 20))
      r.items.forEach((i, j) => expect(Math.abs(r.widths[j] / r.height - aspects[i])).toBeLessThan(0.06))
  })

  it('keeps rows near the target height and the last one at most the target', () => {
    const rows = justify(aspects, 1000, 200, 20)
    for (const r of rows.slice(0, -1)) expect(Math.abs(r.height - 200)).toBeLessThan(100)
    expect(rows.at(-1)!.height).toBeLessThanOrEqual(200)
  })

  it('does not end a row where it would be taller than the view', () => {
    const aspects = [0.5625, 0.667, 1.5]
    // Two tall portraits alone are the closer row to the target, but taller than the view.
    expect(justify(aspects, 1076, 700, 16)[0].height).toBeGreaterThan(776)
    for (const r of justify(aspects, 1076, 700, 16, 776)) expect(r.height).toBeLessThanOrEqual(776)
  })

  it('puts a wide panorama on its own row without overflowing', () => {
    const rows = justify([1, 8, 1], 800, 300, 10)
    const pano = rows.find((r) => r.items.includes(1))!
    expect(pano.widths.reduce((a, b) => a + b, 0) + 10 * (pano.items.length - 1)).toBeLessThanOrEqual(800)
  })

  it('handles an empty library and a single photo', () => {
    expect(justify([], 800, 200, 10)).toEqual([])
    const [r] = justify([1.5], 800, 200, 10)
    expect(r).toEqual({ items: [0], height: 200, widths: [300] })
  })
})
