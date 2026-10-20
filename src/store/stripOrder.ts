import { create } from 'zustand'
import { STRIP } from '../model/strip'
import { tileByCode } from '../model/presetOrder'
import { moveItem, normalizeOrder } from '../model/order'
import type { Collection } from './collections'

/** Your order of the strip, kept in this browser: where each group sits, and the presets inside each catalog set. */
export interface StripOrder {
  /** Group keys: collection ids and set titles. Empty for the default order. */
  groups: string[]
  /** Per set title, its tile codes in your order. */
  sets: Record<string, string[]>
}

export interface StripGroup {
  key: string
  collection: Collection | null
  codes: string[]
}

const KEY = 'studio.stripOrder'
const NONE: StripOrder = { groups: [], sets: {} }

function load(): StripOrder {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as StripOrder | null
    return v && Array.isArray(v.groups) && v.sets && typeof v.sets === 'object' ? v : NONE
  } catch {
    return NONE
  }
}

function save(order: StripOrder) {
  try {
    localStorage.setItem(KEY, JSON.stringify(order))
  } catch {
    /* private mode: the order lasts for this session */
  }
}

const setCodes = (title: string, order: StripOrder) => {
  const all = STRIP.find((s) => s.title === title)!.tiles.map((t) => t.code)
  return order.sets[title] ? normalizeOrder(order.sets[title], all) : all
}

/**
 * The strip's groups in your order. Collections come first and the catalog's sets after them until you move them;
 * a collection made later starts at the front. Collections drop codes the catalog no longer has.
 */
export function orderedGroups(collections: Collection[], order: StripOrder): StripGroup[] {
  const byKey = new Map<string, StripGroup>()
  for (const c of collections) byKey.set(c.id, { key: c.id, collection: c, codes: c.codes.filter((code) => tileByCode(code)) })
  for (const set of STRIP) byKey.set(set.title, { key: set.title, collection: null, codes: setCodes(set.title, order) })
  const placed = order.groups.filter((k) => byKey.has(k))
  const keys = [
    ...collections.map((c) => c.id).filter((k) => !placed.includes(k)),
    ...placed,
    ...STRIP.map((s) => s.title).filter((k) => !placed.includes(k)),
  ]
  return keys.map((k) => byKey.get(k)!)
}

interface StripOrderState extends StripOrder {
  /** Moves a group next to another; `keys` is the order the strip shows now. */
  moveGroup: (keys: string[], key: string, target: string, after: boolean) => void
  /** Moves a preset next to another inside its catalog set. */
  moveInSet: (title: string, code: string, target: string, after: boolean) => void
  reset: () => void
}

export const useStripOrder = create<StripOrderState>((set, get) => {
  const store = (order: StripOrder) => {
    save(order)
    set(order)
  }
  return {
    ...load(),
    moveGroup: (keys, key, target, after) => store({ groups: moveItem(keys, key, target, after), sets: get().sets }),
    moveInSet: (title, code, target, after) =>
      store({ groups: get().groups, sets: { ...get().sets, [title]: moveItem(setCodes(title, get()), code, target, after) } }),
    reset: () => store(NONE),
  }
})

export const isCustomOrder = (o: StripOrder) => o.groups.length > 0 || Object.keys(o.sets).length > 0
