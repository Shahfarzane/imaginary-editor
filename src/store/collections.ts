import { create } from 'zustand'
import { moveItem, placeItem } from '../model/order'

/** Your collections: named sets of preset tiles, shown in the strip after your own presets and kept in this browser. */
export interface Collection {
  id: string
  name: string
  /** Strip tile codes, in the order they were added. */
  codes: string[]
}

const KEY = 'studio.collections'

function load(): Collection[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    if (!Array.isArray(v)) return []
    return v.filter((c): c is Collection => !!c && typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.codes))
  } catch {
    return []
  }
}

function save(list: Collection[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* private mode: the collections last for this session */
  }
}

const unique = (codes: string[]) => [...new Set(codes)]

interface CollectionsState {
  list: Collection[]
  create: (name: string, codes: string[]) => void
  rename: (id: string, name: string) => void
  remove: (id: string) => void
  add: (id: string, codes: string[]) => void
  drop: (id: string, codes: string[]) => void
  /** Puts a preset next to another in the collection, adding it when it is not in it yet. */
  place: (id: string, code: string, target: string | null, after: boolean) => void
  move: (id: string, code: string, target: string, after: boolean) => void
}

export const useCollections = create<CollectionsState>((set, get) => {
  const store = (list: Collection[]) => {
    save(list)
    set({ list })
  }
  const update = (id: string, fn: (c: Collection) => Collection) => store(get().list.map((c) => (c.id === id ? fn(c) : c)))
  return {
    list: load(),
    create: (name, codes) =>
      store([...get().list, { id: crypto.randomUUID(), name: name.trim() || `Collection ${get().list.length + 1}`, codes: unique(codes) }]),
    rename: (id, name) => name.trim() && update(id, (c) => ({ ...c, name: name.trim() })),
    remove: (id) => store(get().list.filter((c) => c.id !== id)),
    add: (id, codes) => update(id, (c) => ({ ...c, codes: unique([...c.codes, ...codes]) })),
    drop: (id, codes) => update(id, (c) => ({ ...c, codes: c.codes.filter((x) => !codes.includes(x)) })),
    place: (id, code, target, after) => update(id, (c) => ({ ...c, codes: placeItem(c.codes, code, target, after) })),
    move: (id, code, target, after) => update(id, (c) => ({ ...c, codes: moveItem(c.codes, code, target, after) })),
  }
})
