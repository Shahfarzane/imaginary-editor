import { GRID_CELLS, LATTICE_MAX_N, LATTICE_N, POST_CELLS, POST_KNOTS, PRO_DENSE, PRO_NODES, PRO_ZERO, type LookParams, type PostStage, type SliderTable } from '../engine/look'
import { TOOL_KNOTS, type ToolStage } from '../engine/tools'

// Looks with curves and color grids ship them quantized: the color grid as int8
// and the channel curves as uint16, both base64. Quantization costs about 0.03
// CIEDE2000 on average.

function bytes(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function decodeGrid(b64: string): number[] {
  const q = new Int8Array(bytes(b64).buffer)
  if (q.length !== GRID_CELLS * 3) throw new Error(`color grid has ${q.length} values, expected ${GRID_CELLS * 3}`)
  return Array.from(q, (v) => v / 127)
}

export function decodeCurves(b64: string): NonNullable<LookParams['channelCurves']> {
  const b = bytes(b64)
  const view = new DataView(b.buffer)
  const n = b.length / 6
  const ch = (c: number) => Array.from({ length: n }, (_, i) => view.getUint16((c * n + i) * 2, true) / 65535)
  return [ch(0), ch(1), ch(2)]
}

/** Bytes of a look lattice with n nodes per axis: float32 scale, then n^3 * 3 12-bit values, two per 3 bytes. */
const latticeBytes = (n: number) => 4 + Math.ceil((n * n * n * 3) / 2) * 3

/**
 * A look's correction lattice: float32 scale (little-endian), then n^3 * 3 values of 12 bits (offset by 2048,
 * /2047 * scale), packed in pairs: a's low byte, a's high nibble with b's low nibble, b's high byte. 12 bits keep
 * every pixel within 0.1 CIEDE2000 of full precision. The node count n comes from the length: LATTICE_N, or up to
 * LATTICE_MAX_N for looks that need a finer lattice.
 */
export function decodeLattice(b64: string): number[] {
  const b = bytes(b64)
  let n = LATTICE_N
  while (n <= LATTICE_MAX_N && latticeBytes(n) !== b.length) n++
  if (n > LATTICE_MAX_N) throw new Error(`lattice has ${b.length} bytes, not a lattice of ${LATTICE_N} to ${LATTICE_MAX_N} nodes per axis`)
  const scale = new DataView(b.buffer).getFloat32(0, true)
  return Array.from({ length: n * n * n * 3 }, (_, k) => {
    const o = 4 + (k >> 1) * 3
    const u = k & 1 ? (b[o + 1] >> 4) | (b[o + 2] << 4) : b[o] | ((b[o + 1] & 15) << 8)
    return ((u - 2048) / 2047) * scale
  })
}

/** Marks state lattices finer than LATTICE_N: the byte STATE_LATTICE_SIZE, then the node count, then the records. */
const STATE_LATTICE_SIZE = 0xff

/**
 * Slider state lattices: records of a uint8 stage index, a float32 scale and n^3 * 3 int8 values (/127 * scale),
 * n = LATTICE_N unless a header gives another size for the whole table. States need less precision than whole
 * looks (8 bits costs under 0.05 CIEDE2000 there). Attaches each to its stage.
 */
export function attachStateLattices(table: SliderTable, b64: string): SliderTable {
  const b = bytes(b64)
  const sized = b[0] === STATE_LATTICE_SIZE
  const n = sized ? b[1] : LATTICE_N
  if (n < LATTICE_N || n > LATTICE_MAX_N) throw new Error(`state lattices of ${n} nodes per axis`)
  const cells = n * n * n * 3
  const size = 1 + 4 + cells
  const start = sized ? 2 : 0
  if ((b.length - start) % size) throw new Error(`state lattices of ${b.length} bytes are not whole records`)
  const view = new DataView(b.buffer)
  for (let o = start; o < b.length; o += size) {
    const stage = table.stages[b[o]]
    if (!stage) throw new Error(`state lattice for missing stage ${b[o]}`)
    const scale = view.getFloat32(o + 1, true)
    stage.lattice = Array.from({ length: cells }, (_, k) => (view.getInt8(o + 5 + k) / 127) * scale)
  }
  return table
}

// Slider tables: per stage int16 curve offsets from the identity (/16384), int16
// chroma gains (/8192), an int16 grid scale (/1024), then int8 grid cells (/127 * scale).
// B&W tables append an input grid to every stage: int16 scale, then int8 cells.
const STAGE_INT16 = POST_KNOTS * 3 + 3 + 1
const STAGE_BYTES = STAGE_INT16 * 2 + POST_CELLS * 3
const INPUT_GRID_BYTES = 2 + POST_CELLS * 3
const FILTER_BYTES = 4 * 2

export function decodeSliders(b64: string): SliderTable {
  const b = bytes(b64)
  const view = new DataView(b.buffer)
  // Film: 15 stages. Pro: 12 single-slider stages, optionally followed by the grid nodes (look.ts PRO_NODES) and the
  // captured state at zero (PRO_ZERO); or a dense table, a state at every point of the 5-step grid (PRO_DENSE).
  // B&W Pro tables also carry a color filter per stage (int16 amount /16384, then R, G, B weights /8192).
  const kinds = [15, 12, 12 + PRO_NODES.length, PRO_ZERO + 1, PRO_DENSE].flatMap((n) => [
    { n, withInput: false, withFilter: false, size: STAGE_BYTES },
    { n, withInput: true, withFilter: false, size: STAGE_BYTES + INPUT_GRID_BYTES },
    { n, withInput: true, withFilter: true, size: STAGE_BYTES + INPUT_GRID_BYTES + FILTER_BYTES },
  ])
  const layout = kinds.find((k) => k.n * k.size === b.length)
  if (!layout) throw new Error(`slider table of ${b.length} bytes matches no layout`)
  const { n, withInput, withFilter, size } = layout
  const stages: PostStage[] = []
  for (let s = 0; s < n; s++) {
    const o = s * size
    const i16 = (k: number) => view.getInt16(o + k * 2, true)
    const curves = Array.from({ length: POST_KNOTS * 3 }, (_, k) => (k % POST_KNOTS) / (POST_KNOTS - 1) + i16(k) / 16384)
    const sat = [0, 1, 2].map((k) => i16(POST_KNOTS * 3 + k) / 8192) as PostStage['sat']
    const scale = i16(POST_KNOTS * 3 + 3) / 1024
    const grid = Array.from({ length: POST_CELLS * 3 }, (_, k) => (view.getInt8(o + STAGE_INT16 * 2 + k) / 127) * scale)
    const stage: PostStage = { curves, sat, grid }
    if (withInput) {
      const oi = o + STAGE_BYTES
      const si = view.getInt16(oi, true) / 1024
      stage.gridIn = Array.from({ length: POST_CELLS * 3 }, (_, k) => (view.getInt8(oi + 2 + k) / 127) * si)
    }
    if (withFilter) {
      const of = o + STAGE_BYTES + INPUT_GRID_BYTES
      const amount = view.getInt16(of, true) / 16384
      const w = [1, 2, 3].map((k) => view.getInt16(of + k * 2, true) / 8192)
      if (amount > 0) stage.filter = [amount, amount * w[0], amount * w[1], amount * w[2]]
    }
    stages.push(stage)
  }
  return { kind: n === 15 ? 'film' : 'pro', stages }
}

/**
 * Tool stage: flags u8 (1: input grid, 2: HSL curve), R, G, B curves as uint16
 * (/65535, TOOL_KNOTS each), output grid int8 (/127), then the optional input grid
 * and HSL curve.
 */
export function decodeToolStage(b64: string): ToolStage {
  const b = bytes(b64)
  const view = new DataView(b.buffer)
  const flags = b[0]
  let o = 1
  const u16 = (n: number) => {
    const out = Array.from({ length: n }, (_, i) => view.getUint16(o + i * 2, true) / 65535)
    o += n * 2
    return out
  }
  const i8 = (n: number) => {
    const out = Array.from({ length: n }, (_, i) => view.getInt8(o + i) / 127)
    o += n
    return out
  }
  const curves: ToolStage['curves'] = [u16(TOOL_KNOTS), u16(TOOL_KNOTS), u16(TOOL_KNOTS)]
  const stage: ToolStage = { curves, grid: i8(GRID_CELLS * 3) }
  if (flags & 1) stage.gridIn = i8(GRID_CELLS * 3)
  if (flags & 2) stage.hsl = u16(TOOL_KNOTS)
  if (o !== b.length) throw new Error(`tool stage has ${b.length - o} stray bytes`)
  return stage
}
