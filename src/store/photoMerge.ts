import type { PhotoRecord } from './db'
import { defaultEdit } from '../model/edit'

export type PhotoPatch = Record<string, { stamp: string; value?: unknown }>
const GROUPS = new Set(['edit.tools', 'edit.fx', 'edit.hsl', 'edit.split', 'edit.curves'])
const TOP = ['name', 'order', 'favorite', 'info'] as const

/** Preset, crop, border and B&W are atomic; individual tools and HSL bands merge independently. */
function fields(p: PhotoRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of TOP) out[key] = p[key]
  for (const [key, value] of Object.entries(p.edit)) {
    const path = `edit.${key}`
    if (GROUPS.has(path)) for (const [k, v] of Object.entries(value)) out[`${path}.${k}`] = v
    else out[path] = value
  }
  return out
}

export function photoPatch(before: PhotoRecord | undefined, after: PhotoRecord, stamp: string): PhotoPatch {
  const prev = before ? fields(before) : {}
  return Object.fromEntries(
    Object.entries(fields(after))
      .filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(prev[key]))
      .map(([key, value]) => [key, { stamp, value }]),
  )
}

/** Applying a recovered operation twice, or after a newer operation, cannot roll a field back. */
export function mergePhoto(current: PhotoRecord, patch: PhotoPatch): PhotoRecord {
  const out = structuredClone(current)
  const defaults = defaultEdit(current.edit.seed)
  out.edit = {
    ...defaults,
    ...out.edit,
    tools: { ...defaults.tools, ...out.edit.tools },
    fx: { ...defaults.fx, ...out.edit.fx },
  }
  const allowed = fields(out)
  out.versions = { ...current.versions }
  for (const [path, change] of Object.entries(patch)) {
    const version = out.versions[path] ?? ''
    if (
      !Object.hasOwn(allowed, path) ||
      change.stamp < version ||
      (change.stamp === version && !version.endsWith(':legacy'))
    )
      continue
    const keys = path.split('.')
    let target = out as unknown as Record<string, unknown>
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
    target[keys.at(-1)!] = change.value
    out.versions[path] = change.stamp
  }
  return out
}
