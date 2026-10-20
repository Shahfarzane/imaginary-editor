import { useCallback } from 'react'
import { useLibrary } from '../store/library'
import type { Edit } from '../model/edit'

/** Value of `get` across the selection: a number when all agree, null when mixed. */
export function useSelectionValue(get: (e: Edit) => number): number | null {
  return useLibrary((s) => {
    let v: number | null | undefined
    for (const id of s.selected) {
      const p = s.photos.find((x) => x.id === id)
      if (!p) continue
      const x = get(p.edit)
      if (v === undefined) v = x
      else if (v !== null && Math.abs(v - x) > 1e-9) v = null
    }
    // undefined: nothing selected; null: selection disagrees (shown as Mixed).
    return v === undefined ? 0 : v
  })
}

/** Slider handlers that edit every selected photo, with one undo step per drag. */
export function useEditSlider(label: string, set: (e: Edit, v: number) => void) {
  const begin = useLibrary((s) => s.begin)
  const commit = useLibrary((s) => s.commit)
  const update = useLibrary((s) => s.updateEdits)
  const onChange = useCallback(
    (v: number) =>
      update((e) => {
        set(e, v)
        return e
      }, label),
    // `set` is an inline lambda; the label uniquely identifies what it edits.
    [update, label],
  )
  return { onBegin: () => begin(label), onChange, onCommit: commit }
}
