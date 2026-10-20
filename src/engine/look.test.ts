import { describe, expect, it } from 'vite-plus/test'
import { applyDims, outputDims, identityPost, LATTICE_CELLS, LATTICE_MAX_N, LATTICE_N, latticeN, MAX_POST_TERMS, NEUTRAL_LOOK, POST_CELLS, PRO_DENSE, PRO_NODES, PRO_ZERO, POST_KNOTS, proTerms, resampleLattice, type LookParams, type PostStage, type SliderTable } from './look'
import { decodeSliders } from '../model/lookPack'
import { buildRenderSpec } from './params'
import { defaultEdit } from '../model/edit'

const NO_DIMS = { contrast: 0, color: 0, tone: 0, character: 0, warmth: 0 }
const stage = (v: number): PostStage => {
  const s = identityPost()
  s.sat = [v, 0, 0]
  s.grid[0] = v
  return s
}
/** The Pro terms' parameters mixed by their weights: the stage the old parameter blend produced. */
const mixed = (out: LookParams): PostStage => {
  const s: PostStage = { curves: identityPost().curves.map(() => 0), sat: [0, 0, 0], grid: identityPost().grid.map(() => 0) }
  for (const { w, stage: t0 } of out.postTerms!) {
    const t = t0 ?? identityPost()
    t.curves.forEach((y, i) => (s.curves[i] += w * y))
    s.sat = s.sat.map((v, i) => v + w * t.sat[i]) as PostStage['sat']
    t.grid.forEach((y, i) => (s.grid[i] += w * y))
  }
  return s
}

describe('slider tables', () => {
  // Film: character -1, -0.5, 0, 0.5, 1 (outer) x warmth -1, 0, 1 (inner); value = index for easy checks.
  const film: SliderTable = { kind: 'film', stages: Array.from({ length: 15 }, (_, i) => (i === 7 ? identityPost() : stage(i))) }

  it('leaves the look alone at zero and drops the table', () => {
    const out = applyDims({ ...NEUTRAL_LOOK, sliders: film }, NO_DIMS)
    expect(out.post).toBeUndefined()
    expect(out.sliders).toBeUndefined()
  })
  it('hits captured states exactly on the grid', () => {
    const out = applyDims({ ...NEUTRAL_LOOK, sliders: film }, { ...NO_DIMS, character: -1, warmth: 1 })
    expect(out.post!.sat[0]).toBeCloseTo(2)
    const out2 = applyDims({ ...NEUTRAL_LOOK, sliders: film }, { ...NO_DIMS, character: 1, warmth: -1 })
    expect(out2.post!.grid[0]).toBeCloseTo(12)
  })
  it('blends bilinearly between states', () => {
    // character 0.75 sits between index 3 (0.5) and 4 (1); warmth 0.5 between 1 (0) and 2 (1).
    const out = applyDims({ ...NEUTRAL_LOOK, sliders: film }, { ...NO_DIMS, character: 0.75, warmth: 0.5 })
    const expected = (10 + 11 + 13 + 14) / 4
    expect(out.post!.sat[0]).toBeCloseTo(expected)
  })
  it('adds Pro sliders and interpolates each from the identity', () => {
    const pro: SliderTable = { kind: 'pro', stages: Array.from({ length: 12 }, (_, i) => stage(i + 1)) }
    const one = applyDims({ ...NEUTRAL_LOOK, sliders: pro }, { ...NO_DIMS, contrast: 0.25 })
    expect(mixed(one).sat[0]).toBeCloseTo(3 / 2) // halfway from identity (0) to the +0.5 stage (3)
    const both = applyDims({ ...NEUTRAL_LOOK, sliders: pro }, { ...NO_DIMS, contrast: 1, tone: -1 })
    expect(mixed(both).sat[0]).toBeCloseTo(4 + 9)
    mixed(both).curves.forEach((y, i) => expect(y).toBeCloseTo(identityPost().curves[i]))
  })
  it('blends captured Pro combinations trilinearly on top of the singles', () => {
    // Singles 1..12; node j holds 100 + j.
    const stages = [...Array.from({ length: 12 }, (_, i) => stage(i + 1)), ...PRO_NODES.map((_, j) => stage(100 + j))]
    const pro: SliderTable = { kind: 'pro', stages }
    expect(PRO_NODES).toHaveLength(20)
    const at = (contrast: number, color: number, tone: number) =>
      mixed(applyDims({ ...NEUTRAL_LOOK, sliders: pro }, { ...NO_DIMS, contrast, color, tone })).sat[0]
    // A node returns its own stage exactly.
    const j = PRO_NODES.findIndex((n) => n.join() === '1,0,-1')
    expect(at(1, 0, -1)).toBeCloseTo(100 + j)
    const k = PRO_NODES.findIndex((n) => n.join() === '1,1,1')
    expect(at(1, 1, 1)).toBeCloseTo(100 + k)
    // One slider alone never reads the nodes.
    expect(at(0.25, 0, 0)).toBeCloseTo(3 / 2)
    // Halfway to a node: singles at 0.5 plus a quarter of what they miss at the node.
    expect(at(0.5, 0, -0.5)).toBeCloseTo(3 + 10 + 0.25 * (100 + j - 4 - 9))
  })
  it('turns a Pro setting into captured states that blend by output', () => {
    const stages = [...Array.from({ length: 12 }, (_, i) => stage(i + 1)), ...PRO_NODES.map((_, j) => stage(100 + j))]
    const terms = (c: number, k: number, t: number) => proTerms(stages, [c, k, t]).terms
    // A captured state is one term of weight 1: a single, and a combination.
    expect(terms(1, 0, 0)).toEqual([{ w: 1, stage: { ...stages[3], lattice: undefined } }])
    const j = PRO_NODES.findIndex((n) => n.join() === '1,-1,0')
    expect(terms(1, -1, 0).map((t) => [t.w, t.stage?.sat[0]])).toEqual([[1, 100 + j]])
    // Anywhere, the weights sum to 1 and at most MAX_POST_TERMS states take part.
    const vals = [-1, -0.75, -0.5, -0.3, 0, 0.2, 0.5, 0.6, 1]
    for (const c of vals)
      for (const k of vals)
        for (const t of vals) {
          const ts = terms(c, k, t)
          expect(ts.reduce((a, x) => a + x.w, 0)).toBeCloseTo(1)
          expect(ts.length).toBeLessThanOrEqual(MAX_POST_TERMS)
        }
    expect(terms(0.5, -0.5, -0.5).length).toBe(MAX_POST_TERMS - 1)
  })
  it('blends a table with a captured state at zero around it, from the look itself', () => {
    const zero = stage(500)
    zero.lattice = Array.from({ length: LATTICE_CELLS }, () => 0.01)
    const stages = [...Array.from({ length: 12 }, (_, i) => stage(i + 1)), ...PRO_NODES.map((_, j) => stage(100 + j)), zero]
    expect(stages).toHaveLength(PRO_ZERO + 1)
    const terms = (c: number, k: number, t: number) => proTerms(stages, [c, k, t]).terms
    const weight = (ts: ReturnType<typeof terms>, v: number | null) => ts.filter((t) => (t.stage?.sat[0] ?? null) === v).reduce((a, t) => a + t.w, 0)
    // Captured states are the state alone, as without a zero state.
    expect(terms(1, 0, 0)).toEqual([{ w: 1, stage: { ...stages[3], lattice: undefined } }])
    expect(terms(-0.5, 0, 0)).toEqual([{ w: 1, stage: { ...stages[1], lattice: undefined } }])
    // Between captured states, the state at zero takes the part the look had: at (0.5, 0.5, 0.5) a weight of -1.375.
    const mid = proTerms(stages, [0.5, 0.5, 0.5])
    expect(weight(mid.terms, null)).toBe(0)
    expect(weight(mid.terms, 500)).toBeCloseTo(-1.375)
    expect(mid.lattice![0]).toBeCloseTo(-1.375 * 0.01)
    // Near zero the look itself keeps its weight (the product of each slider's distance to its first state), so
    // the sliders start from the look: one slider at 0.1 is 0.8 of the look and 0.2 of its state at 0.5.
    const near = terms(0.1, 0, 0)
    expect(weight(near, null)).toBeCloseTo(0.8)
    expect(weight(near, 500)).toBeCloseTo(0)
    expect(weight(near, 3)).toBeCloseTo(0.2)
    expect(weight(terms(0.1, 0.1, 0), null)).toBeCloseTo(0.64)
    const vals = [-1, -0.75, -0.5, -0.3, -0.05, 0, 0.2, 0.25, 0.5, 0.6, 1]
    for (const c of vals)
      for (const k of vals)
        for (const t of vals) {
          if (!c && !k && !t) continue
          const ts = terms(c, k, t)
          expect(ts.reduce((a, x) => a + x.w, 0)).toBeCloseTo(1)
          expect(ts.length).toBeLessThanOrEqual(MAX_POST_TERMS)
        }
  })
  it('draws states in lattice mode as the look itself, in one term, with their lattices blended', () => {
    // Lattice mode: each state is the plain look (an identity stage) plus its lattice.
    const lat = (v: number) => Array.from({ length: LATTICE_CELLS }, () => v)
    const stages = [...Array.from({ length: 12 }, () => identityPost()), ...PRO_NODES.map(() => identityPost()), identityPost()]
    stages.forEach((s, k) => (s.lattice = lat(k / 100)))
    stages[6] = { ...stage(7), lattice: lat(0.05) } // one state (Color +0.5) keeps a stage of its own
    const all = proTerms(stages, [0.7, 0.3, -0.6])
    // Color 0.3 is 0.6 of the way to its +0.5 state; everything else draws the plain look.
    expect(all.terms.map((t) => [t.w, t.stage?.sat[0] ?? null])).toEqual([[expect.closeTo(0.4), null], [expect.closeTo(0.6), 7]])
    // The lattices blend with every state's own weight, as without folding.
    const plain = proTerms(stages.map((s) => ({ ...identityPost(), lattice: s.lattice })), [0.7, 0.3, -0.6])
    expect(plain.terms).toEqual([{ w: expect.closeTo(1), stage: null }])
    expect(plain.lattice![0]).toBeCloseTo(all.lattice![0])
    expect(proTerms(stages, [0, 0.5, 0]).terms.map((t) => [t.w, t.stage?.sat[0]])).toEqual([[1, 7]])
  })
  it('blends a dense table trilinearly on its 5-step grid, the look at the center', () => {
    // State (i, j, l) over the knots -1, -0.5, 0, 0.5, 1 sits at ((i * 5) + j) * 5 + l; value = index for easy checks.
    const lat = (v: number) => Array.from({ length: LATTICE_CELLS }, () => v)
    const stages = Array.from({ length: PRO_DENSE }, (_, k) => ({ ...stage(k), lattice: lat(k / 1000) }))
    const at = (c: number, k: number, t: number) => proTerms(stages, [c, k, t])
    const idx = (c: number, k: number, t: number) => [c, k, t].reduce((a, v) => a * 5 + (v + 1) * 2, 0)
    // A grid point is its state alone.
    expect(at(0.5, -0.5, -0.5).terms).toEqual([{ w: 1, stage: { ...stages[idx(0.5, -0.5, -0.5)], lattice: undefined } }])
    expect(at(0.5, -0.5, -0.5).lattice![0]).toBeCloseTo(idx(0.5, -0.5, -0.5) / 1000)
    // Between grid points, the 8 corners of the cell with trilinear weights; the lattices the same way.
    const mid = at(0.25, -0.75, -0.25)
    expect(mid.terms).toHaveLength(8)
    expect(mid.terms.every((t) => t.w > 0)).toBe(true)
    const corners = [0, 0.5].flatMap((c) => [-1, -0.5].flatMap((k) => [-0.5, 0].map((t) => idx(c, k, t))))
    expect(mid.lattice![0]).toBeCloseTo(corners.reduce((a, k) => a + k / 1000, 0) / 8)
    // The center is the look itself, without a lattice: next to zero the sliders start from the look.
    const near = at(0.25, 0, 0)
    expect(near.terms.map((t) => [t.w, t.stage?.sat[0] ?? null])).toEqual([[0.5, null], [0.5, idx(0.5, 0, 0)]])
    expect(near.lattice![0]).toBeCloseTo(0.5 * (idx(0.5, 0, 0) / 1000))
    const vals = [-1, -0.8, -0.5, -0.3, -0.05, 0, 0.2, 0.5, 0.6, 1]
    for (const c of vals)
      for (const k of vals)
        for (const t of vals) {
          if (!c && !k && !t) continue
          const ts = at(c, k, t).terms
          expect(ts.reduce((a, x) => a + x.w, 0)).toBeCloseTo(1)
          expect(ts.every((x) => x.w > 0)).toBe(true)
          expect(ts.length).toBeLessThanOrEqual(8)
        }
  })
  it('gives each Pro state its own B&W filter', () => {
    const red = identityPost()
    red.filter = [1, 1, 0, 0]
    const half = identityPost()
    half.filter = [0.5, 0.25, 0.25, 0]
    const stages = Array.from({ length: 12 }, () => identityPost())
    stages[4 + 2] = half // Color +0.5
    stages[4 + 3] = red // Color +1
    const at = (color: number) =>
      applyDims({ ...NEUTRAL_LOOK, sliders: { kind: 'pro', stages } }, { ...NO_DIMS, color }).postTerms!.map((t) => [t.w, t.stage?.filter])
    expect(at(1)).toEqual([[1, [1, 1, 0, 0]]])
    expect(at(0.75)).toEqual([[0.5, [0.5, 0.25, 0.25, 0]], [0.5, [1, 1, 0, 0]]])
    expect(at(-1)).toEqual([[1, undefined]])
  })
  it('keeps hand-built dims for the other slider kind', () => {
    const out = applyDims({ ...NEUTRAL_LOOK, sliders: film }, { ...NO_DIMS, contrast: 1 })
    expect(out.post).toBeUndefined()
    expect(out.tone.contrast).toBeGreaterThan(0)
  })
  it('decodes a packed table', () => {
    const bytes = new Uint8Array(12 * ((POST_KNOTS * 3 + 4) * 2 + POST_CELLS * 3))
    const view = new DataView(bytes.buffer)
    view.setInt16(0, 16384, true) // first curve knot +1
    view.setInt16((POST_KNOTS * 3 + 3) * 2, 2048, true) // grid scale 2
    view.setInt8((POST_KNOTS * 3 + 4) * 2, 127) // first grid cell = 1 * scale
    const t = decodeSliders(btoa(String.fromCharCode(...bytes)))
    expect(t.kind).toBe('pro')
    expect(t.stages[0].curves[0]).toBeCloseTo(1)
    expect(t.stages[0].grid[0]).toBeCloseTo(2)
    expect(t.stages[1].curves[POST_KNOTS - 1]).toBeCloseTo(1)
  })
})

describe('correction lattice', () => {
  const lattice = (v: number) => Array.from({ length: LATTICE_CELLS * 3 }, () => v)
  const withLattice = (v: number): PostStage => ({ ...identityPost(), lattice: lattice(v) })

  it('blends state lattices bilinearly with the film stages, missing ones counting as zero', () => {
    const stages = Array.from({ length: 15 }, () => identityPost())
    stages[14] = withLattice(0.4) // character 1, warmth 1
    const film: SliderTable = { kind: 'film', stages }
    const at = (character: number, warmth: number) =>
      applyDims({ ...NEUTRAL_LOOK, sliders: film }, { ...NO_DIMS, character, warmth }).post?.lattice
    expect(at(1, 1)![0]).toBeCloseTo(0.4)
    expect(at(0.75, 0.5)![5]).toBeCloseTo(0.4 * 0.5 * 0.5)
    expect(at(-1, -1)).toBeUndefined()
  })
  it('applies a lattice on the neutral film state at zero and fades it toward the other states', () => {
    const stages = Array.from({ length: 15 }, () => identityPost())
    stages[7] = withLattice(0.3) // character 0, warmth 0
    const film: SliderTable = { kind: 'film', stages }
    const at = (character: number, warmth: number) =>
      applyDims({ ...NEUTRAL_LOOK, sliders: film }, { ...NO_DIMS, character, warmth }).post?.lattice?.[0]
    expect(at(0, 0)).toBeCloseTo(0.3)
    expect(at(0.25, 0)).toBeCloseTo(0.15)
    expect(at(0.5, 0)).toBeCloseTo(0)
    expect(applyDims({ ...NEUTRAL_LOOK, sliders: { kind: 'film', stages: stages.map(() => identityPost()) } }, NO_DIMS).post).toBeUndefined()
  })
  it('adds Pro state lattices per slider and removes a single at a captured combination', () => {
    const stages = [...Array.from({ length: 12 }, () => identityPost()), ...PRO_NODES.map(() => identityPost())]
    stages[3] = withLattice(0.2) // Contrast +1
    const pro: SliderTable = { kind: 'pro', stages }
    const at = (contrast: number, color: number) =>
      applyDims({ ...NEUTRAL_LOOK, sliders: pro }, { ...NO_DIMS, contrast, color }).postLattice?.[0] ?? 0
    expect(at(1, 0)).toBeCloseTo(0.2)
    expect(at(0.75, 0)).toBeCloseTo(0.1)
    // At the (1, 1, 0) node the captured combination replaces what the singles add.
    expect(at(1, 1)).toBeCloseTo(0)
  })
  it('blends finer state lattices and adds them to a coarser look lattice on the finer grid', () => {
    const fine = (v: number) => Array.from({ length: 13 ** 3 * 3 }, () => v)
    const stages = Array.from({ length: 15 }, () => identityPost())
    stages[0] = { ...identityPost(), lattice: fine(0.2) } // character -1, warmth -1
    const look = { ...NEUTRAL_LOOK, lattice: lattice(0.1), sliders: { kind: 'film' as const, stages } }
    const moved = applyDims(look, { ...NO_DIMS, character: -0.75, warmth: -1 })
    expect(moved.post!.lattice).toHaveLength(13 ** 3 * 3)
    expect(moved.post!.lattice![0]).toBeCloseTo(0.2 * 0.5)
    const edit = defaultEdit(1)
    edit.preset = { ...edit.preset, id: 'x', strength: 1, dims: { ...NO_DIMS, character: -0.75, warmth: -1 } }
    const spec = buildRenderSpec(edit, () => look)
    expect(spec.latticeN).toBe(13)
  })
  it('keeps the look lattice through the dims', () => {
    const look = { ...NEUTRAL_LOOK, lattice: lattice(0.3) }
    expect(applyDims(look, { ...NO_DIMS, contrast: 0.5 }).lattice![7]).toBeCloseTo(0.3)
  })

  // Offsets that are linear in the node position: trilinear resampling reproduces them exactly.
  const linear = (n: number) =>
    Array.from({ length: n ** 3 * 3 }, (_, k) => {
      const node = Math.floor(k / 3)
      const [r, g, b] = [node % n, Math.floor(node / n) % n, Math.floor(node / n / n)].map((i) => i / (n - 1))
      return [0.1 * r - 0.05 * b, 0.2 * g, 0.03 * r + 0.07 * g + 0.11 * b][k % 3]
    })
  it('reads the node count from the length and resamples between sizes', () => {
    expect(latticeN(linear(LATTICE_N))).toBe(LATTICE_N)
    expect(latticeN(linear(LATTICE_MAX_N))).toBe(LATTICE_MAX_N)
    const up = resampleLattice(linear(LATTICE_N), LATTICE_MAX_N)
    const want = linear(LATTICE_MAX_N)
    up.forEach((v, i) => expect(v).toBeCloseTo(want[i], 12))
    expect(resampleLattice(want, LATTICE_MAX_N)).toBe(want)
  })
})

describe('hand-built dims on a lattice look', () => {
  const lat = { ...NEUTRAL_LOOK, sat: 1.1, lattice: Array.from({ length: LATTICE_CELLS * 3 }, () => 0.01) }

  it('move the output after the lattice instead of the parameters under it', () => {
    const out = applyDims(lat, { ...NO_DIMS, contrast: 0.5, color: -1, tone: -0.4 })
    expect(out.postAfter).toBe(true)
    expect(out.post!.sat[0]).toBeCloseTo(Math.log(0.45))
    // The look's own parameters stay as fitted, so the lattice still sees the colors it was fitted to.
    expect(out.sat).toBe(1.1)
    expect(out.tone).toEqual(lat.tone)
  })

  it('leave the look alone at zero', () => {
    const out = applyDims(lat, NO_DIMS)
    expect(out.post).toBeUndefined()
    expect(out.postAfter).toBeUndefined()
  })

  it('stay parametric on looks without a lattice', () => {
    const out = applyDims({ ...NEUTRAL_LOOK }, { ...NO_DIMS, color: -1 })
    expect(out.post).toBeUndefined()
    expect(out.sat).toBeCloseTo(0.45)
  })

  it('lift blacks, drop whites and keep the curve monotone', () => {
    const lift = outputDims(0, 0, -1).curves
    expect(lift[0]).toBeCloseTo(0.13)
    expect(lift[POST_KNOTS - 1]).toBeCloseTo(1)
    const drop = outputDims(0, 0, 1).curves
    expect(drop[POST_KNOTS - 1]).toBeCloseTo(0.88)
    for (const c of [-1, 1]) {
      const y = outputDims(c, 0, 0).curves.slice(0, POST_KNOTS)
      for (let i = 1; i < y.length; i++) expect(y[i]).toBeGreaterThan(y[i - 1])
    }
    expect(outputDims(0, 0, 0)).toEqual(identityPost())
  })
})

describe('strength base', () => {
  const base = (n: number, v: number) => Array.from({ length: n ** 3 * 3 }, () => v)
  const spec = (look: LookParams, strength: number) => {
    const edit = defaultEdit(1)
    edit.preset = { ...edit.preset, id: 'x', strength, dims: NO_DIMS }
    return buildRenderSpec(edit, () => look)
  }

  it('goes to the bake as a lattice of its own, at any node count', () => {
    for (const n of [LATTICE_N, 11, LATTICE_MAX_N]) {
      const s = spec({ ...NEUTRAL_LOOK, strengthBase: base(n, -0.25) }, 0.5)
      expect(s.bake.uLkBaseOn).toBe(1)
      expect(s.bake.uLkBaseN).toEqual({ int: n })
      expect(s.baseN).toBe(n)
      expect(s.baseLattice).toHaveLength(n ** 3 * 4)
      expect(s.baseLattice![0]).toBeCloseTo(-0.25)
    }
  })
  it('is off for a look without one, and keeps the look lattice apart', () => {
    const s = spec({ ...NEUTRAL_LOOK, lattice: base(LATTICE_N, 0.1) }, 0.5)
    expect(s.bake.uLkBaseOn).toBe(0)
    expect(s.baseLattice).toBeNull()
    const both = spec({ ...NEUTRAL_LOOK, lattice: base(LATTICE_N, 0.1), strengthBase: base(LATTICE_MAX_N, -0.2) }, 0.5)
    expect(both.latticeN).toBe(LATTICE_N)
    expect(both.lattice![0]).toBeCloseTo(0.1)
    expect(both.baseN).toBe(LATTICE_MAX_N)
  })
  it('survives the dims and changes the bake key', () => {
    const look = { ...NEUTRAL_LOOK, strengthBase: base(LATTICE_N, -0.25) }
    expect(applyDims(look, { ...NO_DIMS, contrast: 0.5 }).strengthBase).toEqual(look.strengthBase)
    expect(spec(look, 0.5).lutKey).not.toBe(spec({ ...NEUTRAL_LOOK }, 0.5).lutKey)
  })
})
