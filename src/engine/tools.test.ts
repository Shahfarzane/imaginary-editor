import { describe, expect, it } from 'vite-plus/test'
import { GRID_CELLS } from './look'
import { stageAt, TOOL_KNOTS, type ToolStage, type ToolTable } from './tools'
import { toolTables, toolTablesLoaded } from '../model/toolData'

const flat = (v: number): ToolStage => ({
  curves: [0, 1, 2].map(() => Array.from({ length: TOOL_KNOTS }, (_, i) => i / (TOOL_KNOTS - 1) + v)) as ToolStage['curves'],
  grid: Array.from({ length: GRID_CELLS * 3 }, () => v),
})

describe('tool stages', () => {
  const table: ToolTable = { values: [-1, -0.5, -0.25, 0.25, 0.5, 1], stages: [-1, -0.5, -0.25, 0.25, 0.5, 1].map(flat) }

  it('is off at zero', () => {
    expect(stageAt(table, 0)).toBeNull()
  })
  it('hits captured values exactly', () => {
    expect(stageAt(table, 0.5)!.grid[0]).toBeCloseTo(0.5)
    expect(stageAt(table, -1)!.grid[5]).toBeCloseTo(-1)
  })
  it('interpolates from the identity at zero', () => {
    const s = stageAt(table, 0.125)!
    expect(s.grid[0]).toBeCloseTo(0.125)
    expect(s.curves[1][TOOL_KNOTS - 1]).toBeCloseTo(1 + 0.125)
  })
  it('clamps beyond the captured range', () => {
    expect(stageAt(table, 2)!.grid[0]).toBeCloseTo(1)
  })
  it('runs every tool on its built-in formula: no tool tables load', async () => {
    await toolTablesLoaded
    expect(toolTables()).toBeNull()
  })
})
