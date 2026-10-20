import { originalWithCrop } from '../model/edit'
import { tileOf, type StripTile } from '../model/strip'
import { useLibrary } from '../store/library'
import { usePreview } from './preview'

const NO_DIMS = { contrast: 0, color: 0, tone: 0, character: 0, warmth: 0 }

/** Back to the photo as it came in, in its current framing (the toolbar's Reset to original). */
export function backToOriginal() {
  usePreview.getState().set(null)
  useLibrary.getState().updateEdits((e) => originalWithCrop(e), 'Back to original')
}

/** Apply a preset to the selection at its defaults, or take the preset off (null). */
export function applyPreset(tile: StripTile | null) {
  useLibrary.getState().updateEdits(
    // Removing a preset also clears a custom look (older Mixer, Match or Surprise edits), which renders whatever the id says.
    (e) => ({
      ...e,
      preset: tile
        ? { id: tile.look, strength: 1, dims: { ...NO_DIMS }, tile: tile.code }
        : { ...e.preset, id: null, custom: undefined, mix: undefined, label: undefined, tile: undefined },
    }),
    tile ? `Preset ${tile.code}` : 'Remove preset',
  )
}

/** The tile shared by the whole selection: its code, null for none, '__mixed' when they differ. */
export function useCurrentTile() {
  return useLibrary((st) => {
    let code: string | null | undefined
    for (const sid of st.selected) {
      const p = st.photos.find((x) => x.id === sid)
      if (!p) continue
      const c = tileOf(p.edit.preset)?.code ?? null
      if (code === undefined) code = c
      else if (code !== c) return '__mixed'
    }
    return code ?? null
  })
}
