import { describe, expect, it } from 'vite-plus/test'
import { attachStateLattices, decodeCurves, decodeGrid, decodeLattice, decodeSliders } from './lookPack'
import { GRID_CELLS, identityPost, LATTICE_CELLS, LATTICE_MAX_N, LATTICE_N, PRO_DENSE, PRO_NODES, PRO_ZERO } from '../engine/look'
import { PRESETS, loadAllSliders } from './presets'

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

describe('look packing', () => {
  it('decodes an int8 grid to -1..1', () => {
    const q = new Int8Array(GRID_CELLS * 3)
    q[0] = 127
    q[1] = -127
    q[2] = 64
    const g = decodeGrid(b64(new Uint8Array(q.buffer)))
    expect(g).toHaveLength(GRID_CELLS * 3)
    expect(g[0]).toBe(1)
    expect(g[1]).toBe(-1)
    expect(g[2]).toBeCloseTo(64 / 127, 6)
  })
  it('rejects a grid of the wrong size', () => {
    expect(() => decodeGrid(b64(new Uint8Array(12)))).toThrow()
  })
  it('decodes little-endian uint16 channel curves', () => {
    const n = 3
    const q = new Uint16Array([0, 32768, 65535, 0, 0, 65535, 65535, 65535, 65535])
    const c = decodeCurves(b64(new Uint8Array(q.buffer)))
    expect(c.map((ch) => ch.length)).toEqual([n, n, n])
    expect(c[0][2]).toBe(1)
    expect(c[0][1]).toBeCloseTo(0.5, 4)
    expect(c[2]).toEqual([1, 1, 1])
  })
  it('every fitted preset decodes monotone curves and a full grid', () => {
    for (const p of PRESETS) {
      const cc = p.look.channelCurves
      if (!cc) continue
      for (const ch of cc) for (let i = 1; i < ch.length; i++) expect(ch[i]).toBeGreaterThanOrEqual(ch[i - 1])
      if (p.look.grid) expect(p.look.grid).toHaveLength(GRID_CELLS * 3)
      if (p.look.gridIn) expect(p.look.gridIn).toHaveLength(GRID_CELLS * 3)
    }
  })
  it('loads with no slider tables: the Lab looks have none', async () => {
    await loadAllSliders()
    expect(PRESETS.filter((p) => p.look.sliders)).toEqual([])
  })
})

describe('slider table layouts', () => {
  it('tell every stage count and stage size apart by length', () => {
    const plain = (17 * 3 + 4) * 2 + 4 * 12 * 2 * 3
    const sizes = [plain, plain + 2 + 4 * 12 * 2 * 3, plain + 2 + 4 * 12 * 2 * 3 + 8]
    const lengths = [15, 12, 12 + PRO_NODES.length, PRO_ZERO + 1, PRO_DENSE].flatMap((n) => sizes.map((s) => n * s))
    expect(new Set(lengths).size).toBe(lengths.length)
    const t = decodeSliders(b64(new Uint8Array((PRO_ZERO + 1) * sizes[1])))
    expect(t.kind).toBe('pro')
    expect(t.stages).toHaveLength(PRO_ZERO + 1)
  })
})

describe('slider tables with a B&W filter', () => {
  it('decodes the filter after the input grid, premultiplied', () => {
    const stage = (17 * 3 + 4) * 2 + 4 * 12 * 2 * 3 + (2 + 4 * 12 * 2 * 3) + 8
    const bytes = new Uint8Array(12 * stage)
    const view = new DataView(bytes.buffer)
    const of = stage - 8
    view.setInt16(of, 8192, true) // amount 0.5
    view.setInt16(of + 2, 8192, true) // R weight 1
    const t = decodeSliders(b64(bytes))
    expect(t.kind).toBe('pro')
    expect(t.stages[0].filter).toEqual([0.5, 0.5, 0, 0])
    expect(t.stages[1].filter).toBeUndefined()
  })
})

describe('correction lattice packing', () => {
  // 12-bit values offset by 2048, packed in pairs over 3 bytes (lookPack.ts decodeLattice, pack.py lattice_bytes).
  const packed = (scale: number, values: Record<number, number>, n = LATTICE_N, pad = 0) => {
    const count = n ** 3 * 3
    const bytes = new Uint8Array(4 + Math.ceil(count / 2) * 3 + pad)
    new DataView(bytes.buffer).setFloat32(0, scale, true)
    for (let k = 0; k < count; k++) {
      const u = (values[k] ?? 0) + 2048
      const o = 4 + (k >> 1) * 3
      if (k & 1) {
        bytes[o + 1] |= (u & 15) << 4
        bytes[o + 2] = u >> 4
      } else {
        bytes[o] = u & 255
        bytes[o + 1] |= u >> 8
      }
    }
    return bytes
  }
  it('decodes 12-bit values times the scale', () => {
    const g = decodeLattice(b64(packed(0.5, { 0: 2047, 1: -2047, 5: 1024 })))
    expect(g).toHaveLength(LATTICE_CELLS * 3)
    expect(g[0]).toBeCloseTo(0.5, 6)
    expect(g[1]).toBeCloseTo(-0.5, 6)
    expect(g[5]).toBeCloseTo(0.25, 3)
    expect(g[6]).toBe(0)
  })
  it('decodes a finer look lattice, its node count read from the length', () => {
    const g = decodeLattice(b64(packed(0.25, { 3992: 2047, 3991: -1 }, LATTICE_MAX_N)))
    expect(g).toHaveLength(LATTICE_MAX_N ** 3 * 3)
    expect(g[3992]).toBeCloseTo(0.25, 6)
    expect(g[3991]).toBeCloseTo(-0.25 / 2047, 8)
  })
  it('rejects a lattice of the wrong size', () => {
    expect(() => decodeLattice(b64(new Uint8Array(40)))).toThrow()
    expect(() => decodeLattice(b64(packed(1, {}, 8)))).toThrow()
    expect(() => decodeLattice(b64(packed(1, {}, LATTICE_MAX_N + 1)))).toThrow()
    expect(() => decodeLattice(b64(packed(1, {}, LATTICE_N, 3)))).toThrow()
  })
  const record = (stage: number, scale: number, values: Record<number, number>, n = LATTICE_N) => {
    const r = new Uint8Array(1 + 4 + n ** 3 * 3)
    const view = new DataView(r.buffer)
    r[0] = stage
    view.setFloat32(1, scale, true)
    for (const [k, v] of Object.entries(values)) view.setInt8(5 + Number(k), v)
    return r
  }
  it('attaches int8 state lattices to their stages by index', () => {
    const recordOld = (stage: number, scale: number, values: Record<number, number>) => {
      const r = new Uint8Array(1 + 4 + LATTICE_CELLS * 3)
      const view = new DataView(r.buffer)
      r[0] = stage
      view.setFloat32(1, scale, true)
      for (const [k, v] of Object.entries(values)) view.setInt8(5 + Number(k), v)
      return r
    }
    const a = recordOld(3, 1, { 2: 127 })
    const bytes = new Uint8Array(2 * a.length)
    bytes.set(a, 0)
    bytes.set(recordOld(14, 2, { 0: -127 }), a.length)
    const table = attachStateLattices({ kind: 'film', stages: Array.from({ length: 15 }, () => identityPost()) }, b64(bytes))
    expect(table.stages[3].lattice![2]).toBeCloseTo(1)
    expect(table.stages[14].lattice![0]).toBeCloseTo(-2)
    expect(table.stages[0].lattice).toBeUndefined()
  })
  it('reads finer state lattices after a size header, for the whole table', () => {
    const a = record(0, 1, { 5: 127 }, 13)
    const bytes = new Uint8Array(2 + 2 * a.length)
    bytes.set([0xff, 13], 0)
    bytes.set(a, 2)
    bytes.set(record(7, 0.5, { [13 ** 3 * 3 - 1]: -127 }, 13), 2 + a.length)
    const table = attachStateLattices({ kind: 'film', stages: Array.from({ length: 15 }, () => identityPost()) }, b64(bytes))
    expect(table.stages[0].lattice).toHaveLength(13 ** 3 * 3)
    expect(table.stages[0].lattice![5]).toBeCloseTo(1)
    expect(table.stages[7].lattice![13 ** 3 * 3 - 1]).toBeCloseTo(-0.5)
    const film = () => ({ kind: 'film' as const, stages: Array.from({ length: 15 }, () => identityPost()) })
    expect(() => attachStateLattices(film(), b64(new Uint8Array([0xff, LATTICE_MAX_N + 1, ...record(0, 1, {}, 9)])))).toThrow()
    expect(() => attachStateLattices(film(), b64(new Uint8Array([0xff, 13, ...record(0, 1, {}, 9)])))).toThrow()
  })
  it('every preset lattice decodes to the full node count', async () => {
    await loadAllSliders()
    for (const p of PRESETS) {
      if (p.look.lattice) expect([9, 10, 11, 12, 13].filter((n) => n <= LATTICE_MAX_N).map((n) => n ** 3 * 3)).toContain(p.look.lattice.length)
      // A table's state lattices share one size, LATTICE_N up to LATTICE_MAX_N nodes per axis.
      const sizes = new Set((p.look.sliders?.stages ?? []).flatMap((s) => (s.lattice ? [s.lattice.length] : [])))
      expect(sizes.size).toBeLessThanOrEqual(1)
      for (const len of sizes) expect([9, 10, 11, 12, 13].filter((n) => n <= LATTICE_MAX_N).map((n) => n ** 3 * 3)).toContain(len)
    }
  })
})

describe('strength bases in the catalog', () => {
  it('decode where a look has one', () => {
    const withBase = PRESETS.filter((p) => p.look.strengthBase)
    for (const p of withBase) {
      const n = Math.round((p.look.strengthBase!.length / 3) ** (1 / 3))
      expect(n).toBeGreaterThanOrEqual(LATTICE_N)
      expect(n).toBeLessThanOrEqual(LATTICE_MAX_N)
      expect(p.look.strengthBase).toHaveLength(n ** 3 * 3)
    }
  })
})
