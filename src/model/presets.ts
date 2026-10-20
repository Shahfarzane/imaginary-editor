import { resolveLook, type DimKind, type LookDef, type LookParams } from '../engine/look'
import { CATALOG, CATALOG_FAMILIES, type CatalogPreset } from './catalog'
import { attachStateLattices, decodeCurves, decodeGrid, decodeLattice, decodeSliders } from './lookPack'
import { loaders, type PackedTable } from 'virtual:slider-index'

// The catalog (catalog.ts): each look is a parametric film model, optionally with
// channel curves, color grids and a correction lattice packed by lookPack.ts.

export interface Preset {
  id: string
  code: string
  name: string
  family: string
  dims: DimKind
  look: LookDef
}

export interface Family {
  id: string
  title: string
  color: string
  /** Film stocks render as light chips with colored text. */
  chip: 'fill' | 'stock'
  dims: DimKind
}

export const FAMILIES: Family[] = CATALOG_FAMILIES

// Fitted parts decode on first use: decoding all of them up front costs over 100 ms at startup.
const decoded = new Map<string, LookDef>()
const CACHE_LIMIT = 8
const sliderData = new Map<string, PackedTable>()
const loading = new Map<string, Promise<void>>()
const retryAfter = new Map<string, number>()
const readyListeners = new Set<(id: string) => void>()

function sliderTable(code: string) {
  const packed = sliderData.get(code)
  if (!packed) return undefined
  const table = decodeSliders(packed.sliders)
  return packed.lattices ? attachStateLattices(table, packed.lattices) : table
}

function lookDef(e: CatalogPreset): LookDef {
  if (!sliderData.has(e.code) && Date.now() >= (retryAfter.get(e.code) ?? 0)) {
    void ensureSliders(e.code.toLowerCase()).catch(() => {})
  }
  let look = decoded.get(e.code)
  if (!look) {
    look = { ...e.look }
    if (e.curves) look.channelCurves = decodeCurves(e.curves)
    if (e.grid) look.grid = decodeGrid(e.grid)
    if (e.gridIn) look.gridIn = decodeGrid(e.gridIn)
    if (e.lattice) look.lattice = decodeLattice(e.lattice)
    if (e.strengthBase) look.strengthBase = decodeLattice(e.strengthBase)
    const table = sliderTable(e.code)
    if (table) look.sliders = table
  }
  decoded.delete(e.code)
  decoded.set(e.code, look)
  while (decoded.size > CACHE_LIMIT) {
    const oldest = decoded.keys().next().value!
    decoded.delete(oldest)
    resolved.delete(oldest.toLowerCase())
  }
  return look
}

export const PRESETS: Preset[] = CATALOG.map((e) => {
  const fam = FAMILIES.find((f) => f.id === e.family)!
  return {
    id: e.code.toLowerCase(),
    code: e.code,
    name: e.name,
    family: e.family,
    dims: fam.dims,
    get look() {
      return lookDef(e)
    },
  }
})

const byId = new Map(PRESETS.map((p) => [p.id, p]))
const resolved = new Map<string, LookParams>()

export const getPreset = (id: string | null) => (id ? (byId.get(id) ?? null) : null)
export const familyOf = (p: Preset) => FAMILIES.find((f) => f.id === p.family)!

/** Look params for a preset id. */
export function lookFor(id: string): LookParams | null {
  // Touch the decoded cache on every use, including already-resolved looks.
  const p = byId.get(id)
  if (!p) return null
  const look = p.look
  let r = resolved.get(id)
  if (!r) {
    r = resolveLook(look)
    resolved.set(id, r)
  }
  return r
}

/** Load only the requested look. Export awaits this, so a loading failure cannot silently change its colors. */
export function ensureSliders(id: string | null): Promise<void> {
  const code = id ? byId.get(id)?.code : undefined
  if (!code || !loaders[code] || sliderData.has(code)) return Promise.resolve()
  let task = loading.get(code)
  if (!task) {
    task = loaders[code]()
      .then((data) => {
        sliderData.set(code, data)
        const look = decoded.get(code)
        if (look) look.sliders = sliderTable(code)
        resolved.delete(id!)
        retryAfter.delete(code)
        readyListeners.forEach((notify) => notify(id!))
      })
      .catch((error: unknown) => {
        retryAfter.set(code, Date.now() + 30_000)
        throw error
      })
      .finally(() => loading.delete(code))
    loading.set(code, task)
  }
  return task
}

export function onSlidersReady(notify: (id: string) => void) {
  readyListeners.add(notify)
  return () => readyListeners.delete(notify)
}

/** Explicitly awaited by catalog tests and offline measurements. Merely importing presets downloads no tables. */
export async function loadAllSliders(): Promise<void> {
  await Promise.all(Object.keys(loaders).map((code) => ensureSliders(code.toLowerCase())))
}

/** Numeric payload count, independent of garbage collection and browser heap reporting. */
export function presetCacheStats() {
  const seen = new Set<object>()
  const count = (v: unknown): number => {
    if (typeof v === 'number') return 1
    if (!v || typeof v !== 'object' || seen.has(v)) return 0
    seen.add(v)
    return Object.values(v).reduce((n: number, child: unknown) => n + count(child), 0)
  }
  const retainedNumbers = [...decoded.values(), ...resolved.values()].reduce((n, look) => n + count(look), 0)
  return {
    decoded: decoded.size,
    resolved: resolved.size,
    retainedNumbers,
    loadedTables: sliderData.size,
    pendingTables: loading.size,
    limit: CACHE_LIMIT,
  }
}
