import { create } from 'zustand'
import { cloneEdit, defaultEdit, type Edit } from '../model/edit'
import { deleteUserPreset, loadUserPresets, putUserPreset, type RecipeRecord } from './db'

/** A preset from an edit: every look, tool and effect setting, without the framing or the photo's grain seed. */
export function presetEdit(e: Edit): Edit {
  const d = defaultEdit(0)
  return { ...cloneEdit(e), crop: d.crop, seed: d.seed }
}

interface UserPresetsState {
  list: RecipeRecord[]
  load: () => Promise<void>
  save: (name: string, edit: Edit) => Promise<RecipeRecord>
  rename: (id: string, name: string) => Promise<void>
  remove: (id: string) => Promise<void>
}

export const useUserPresets = create<UserPresetsState>((set, get) => ({
  list: [],
  async load() {
    set({ list: await loadUserPresets() })
  },
  async save(name, edit) {
    const r: RecipeRecord = { id: crypto.randomUUID(), name: name.trim() || 'My preset', edit: presetEdit(edit), created: Date.now() }
    await putUserPreset(r)
    set({ list: [...get().list, r] })
    return r
  },
  async rename(id, name) {
    const r = get().list.find((x) => x.id === id)
    if (!r || !name.trim()) return
    const next = { ...r, name: name.trim() }
    await putUserPreset(next)
    set({ list: get().list.map((x) => (x.id === id ? next : x)) })
  },
  async remove(id) {
    await deleteUserPreset(id)
    set({ list: get().list.filter((x) => x.id !== id) })
  },
}))
