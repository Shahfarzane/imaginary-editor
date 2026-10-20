import type { StagedTool, ToolTable } from '../engine/tools'

// Tools run on the built-in formulas (src/engine/tools.ts); no fitted tool tables ship with this repository.
export const toolTablesLoaded: Promise<void> = Promise.resolve()

export const toolTables = (): Record<StagedTool, ToolTable> | null => null
