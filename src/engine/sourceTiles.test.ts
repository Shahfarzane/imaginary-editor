import { describe, expect, it } from 'vite-plus/test'
import { defaultEdit } from '../model/edit'
import { apply } from './color'
import { cropPixelSize, outputToSource } from './geometry'
import { exportTiles } from './sourceTiles'

describe('source tile planning', () => {
  it('covers the output once and keeps rotated, flipped and aberrated regions inside the source and GPU', () => {
    for (const rot90 of [0, 1, 2, 3] as const) {
      const crop = { ...defaultEdit(1).crop, rot90, straighten: 7, flipH: true, x: 0.1, y: 0.1, w: 0.8, h: 0.8 }
      const [W, H] = cropPixelSize(crop, 913, 607)
      const xform = outputToSource(crop, 913, 607)
      const center = apply(xform, [0.5, 0.5, 1]).slice(0, 2) as [number, number]
      const tiles = exportTiles(W, H, 256, 4, { width: 913, height: 607, xform, center, aberration: 1 })
      const coverage = new Uint8Array(W * H)
      for (const t of tiles) {
        expect(t.width + 8).toBeLessThanOrEqual(256)
        expect(t.height + 8).toBeLessThanOrEqual(256)
        expect(t.source!.width).toBeLessThanOrEqual(256)
        expect(t.source!.height).toBeLessThanOrEqual(256)
        expect(t.source!.x).toBeGreaterThanOrEqual(0)
        expect(t.source!.y).toBeGreaterThanOrEqual(0)
        expect(t.source!.x + t.source!.width).toBeLessThanOrEqual(914)
        expect(t.source!.y + t.source!.height).toBeLessThanOrEqual(608)
        for (let y = t.y; y < t.y + t.height; y++) for (let x = t.x; x < t.x + t.width; x++) coverage[y * W + x]++
      }
      expect(coverage.every((n) => n === 1)).toBe(true)
    }
  })
})
