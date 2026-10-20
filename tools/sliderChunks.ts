import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite-plus'

/** Split the generated source of truth into one lazy chunk per look, without duplicating generated files. */
export function sliderChunks(): Plugin {
  const file = fileURLToPath(new URL('../src/model/catalogSliders.ts', import.meta.url))
  const prefix = 'virtual:slider-table/'
  let tables: Record<string, Record<string, string>> | null = null
  const read = () => {
    if (tables) return tables
    tables = {}
    let record: Record<string, string> = {}
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const name = /^export const (\w+)/.exec(line)
      if (name) record = tables[name[1]] = {}
      const entry = /^\s+(\w+): "([^"]*)",/.exec(line)
      if (entry) record[entry[1]] = entry[2]
    }
    return tables
  }
  return {
    name: 'slider-chunks',
    resolveId(id) {
      if (id === 'virtual:slider-index' || id.startsWith(prefix)) return '\0' + id
    },
    load(id) {
      if (!id.startsWith('\0virtual:slider-')) return
      this.addWatchFile(file)
      const t = read()
      if (id === '\0virtual:slider-index') {
        return `export const loaders = {${Object.keys(t.SLIDERS)
          .map((code) => `${JSON.stringify(code)}:()=>import(${JSON.stringify(prefix + code)})`)
          .join(',')}}`
      }
      const code = id.slice(prefix.length + 1)
      if (!(code in t.SLIDERS)) throw new Error(`Unknown slider table ${code}`)
      return `export const sliders=${JSON.stringify(t.SLIDERS[code])}; export const lattices=${JSON.stringify(t.SLIDER_LATTICES?.[code] ?? '')};`
    },
    handleHotUpdate(ctx) {
      if (ctx.file !== file) return
      tables = null
      for (const [id, mod] of ctx.server.moduleGraph.idToModuleMap) {
        if (id.startsWith('\0virtual:slider-')) ctx.server.moduleGraph.invalidateModule(mod)
      }
      ctx.server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}
