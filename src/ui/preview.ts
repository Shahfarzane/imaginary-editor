import { create } from 'zustand'
import type { Edit } from '../model/edit'
import type { LookParams } from '../engine/look'

// Hover previews: a preset (or any look) shown on the active photo without committing.
export const usePreview = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({
  id: null,
  set: (id) => set({ id }),
}))

export function withPreview(edit: Edit, id: string | null): Edit {
  if (!id) return edit
  return { ...edit, preset: { id, strength: 1, dims: { contrast: 0, color: 0, tone: 0, character: 0, warmth: 0 } } }
}

export type { LookParams }
