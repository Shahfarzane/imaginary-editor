
// Tool stages: how the fitted tools transform color, captured at fixed slider
// values. A stage has the same form as a fitted look: an input color grid, a
// curve per channel (33 knots), an output grid, and for Saturation an HSL
// saturation curve applied first. Between captured values the stage
// parameters are interpolated; at 0 a tool is the identity.

export const TOOL_KNOTS = 33

export interface ToolStage {
  curves: [number[], number[], number[]]
  grid: number[]
  gridIn?: number[]
  hsl?: number[]
}

export interface ToolTable {
  values: number[]
  stages: ToolStage[]
}

/** Stages before the look, then after it, each in a fixed order. */
export const PRE_TOOLS = ['exposure', 'temperature', 'tint'] as const
export const POST_TOOLS = ['contrast', 'saturation', 'skinTone', 'fade'] as const
export const STAGED_TOOLS = [...PRE_TOOLS, ...POST_TOOLS] as const
export type StagedTool = (typeof STAGED_TOOLS)[number]

const knots = () => Array.from({ length: TOOL_KNOTS }, (_, i) => i / (TOOL_KNOTS - 1))

function identity(like: ToolStage): ToolStage {
  const k = knots()
  const s: ToolStage = { curves: [k, k, k], grid: Array.from({ length: like.grid.length }, () => 0) }
  if (like.gridIn) s.gridIn = Array.from({ length: like.gridIn.length }, () => 0)
  if (like.hsl) s.hsl = k
  return s
}

function mix(a: ToolStage, b: ToolStage, t: number): ToolStage {
  const l = (x: number[], y: number[]) => x.map((v, i) => v + (y[i] - v) * t)
  const out: ToolStage = { curves: [l(a.curves[0], b.curves[0]), l(a.curves[1], b.curves[1]), l(a.curves[2], b.curves[2])], grid: l(a.grid, b.grid) }
  if (a.gridIn || b.gridIn) {
    const z = Array.from({ length: a.grid.length }, () => 0)
    out.gridIn = l(a.gridIn ?? z, b.gridIn ?? z)
  }
  if (a.hsl || b.hsl) out.hsl = l(a.hsl ?? knots(), b.hsl ?? knots())
  return out
}

/** The stage for slider value v, or null when the tool is off. */
export function stageAt(table: ToolTable, v: number): ToolStage | null {
  if (!v) return null
  const vs = [...table.values, 0].sort((a, b) => a - b)
  const at = (x: number) => (x === 0 ? identity(table.stages[0]) : table.stages[table.values.indexOf(x)])
  const x = Math.min(Math.max(v, vs[0]), vs[vs.length - 1])
  let i = 0
  while (i < vs.length - 2 && x > vs[i + 1]) i++
  return mix(at(vs[i]), at(vs[i + 1]), (x - vs[i]) / (vs[i + 1] - vs[i]))
}

