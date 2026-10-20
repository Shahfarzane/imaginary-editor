import s from './SelectionBar.module.css'
import * as I from './icons'
import { inSingleView, useLibrary } from '../store/library'
import { isUnedited } from '../model/edit'
import { backToOriginal } from './presetActions'

const ICON = { width: 20, height: 20 }

/**
 * Actions on the selected photos, floating over the top of the canvas. It shows only while something
 * is selected, and not in crop, which takes over the canvas. Undo and redo are global and stay in the rail.
 */
export function SelectionBar() {
  const st = useLibrary()
  const count = st.selected.length
  if (!count || st.panel === 'adjust') return null
  const single = inSingleView(st)
  const favorite = st.photos.filter((p) => st.selected.includes(p.id)).every((p) => p.favorite)
  const edited = st.selected.some((id) => {
    const p = st.photos.find((x) => x.id === id)
    return p && !isUnedited(p.edit)
  })
  return (
    <div className={s.bar} role="toolbar" aria-label="Selection">
      {!single && (
        <>
          <span className={s.count}>{count} selected</span>
          <button className={s.clear} aria-label="Clear selection" title="Clear selection (Esc)" onClick={st.clearSelection}>
            <I.Close width={16} height={16} />
          </button>
          <span className={s.sep} />
        </>
      )}
      <Action tip="Copy edits" kbd="⌘C" onClick={st.copy}>
        <I.Copy {...ICON} />
      </Action>
      <Action tip="Paste edits" kbd="⌘V" onClick={st.paste} disabled={!st.clipboard}>
        <I.Paste {...ICON} />
      </Action>
      <span className={s.sep} />
      <Action tip="Reset to original" onClick={backToOriginal} disabled={!edited}>
        <I.Reset {...ICON} />
      </Action>
      <Action tip={favorite ? 'Unfavorite' : 'Favorite'} kbd="." onClick={st.toggleFavorite} fav={favorite}>
        <I.Heart {...ICON} />
      </Action>
      {single ? (
        <button
          className={`${s.btn} ${st.showOriginal ? s.held : ''}`}
          aria-label="Show original"
          onPointerDown={() => st.setShowOriginal(true)}
          onPointerUp={() => st.setShowOriginal(false)}
          onPointerLeave={() => st.setShowOriginal(false)}
        >
          <I.Compare {...ICON} />
          <span className={s.tip}>
            Hold to show original<kbd>\</kbd>
          </span>
        </button>
      ) : (
        <Action tip="Isolate" kbd="I" onClick={st.toggleIsolate} on={st.isolate}>
          <I.Isolate {...ICON} />
        </Action>
      )}
      <Action tip="Delete" kbd="⌫" onClick={st.removeSelected}>
        <I.Trash {...ICON} />
      </Action>
    </div>
  )
}

function Action({
  tip,
  kbd,
  onClick,
  disabled,
  on,
  fav,
  children,
}: {
  tip: string
  kbd?: string
  onClick: () => void
  disabled?: boolean
  on?: boolean
  /** A favorite heart: red and filled when on. */
  fav?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      className={`${s.btn} ${on ? s.on : ''} ${fav ? s.fav : ''}`}
      aria-label={tip}
      aria-pressed={on ?? fav}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
      <span className={s.tip}>
        {tip}
        {kbd && <kbd>{kbd}</kbd>}
      </span>
    </button>
  )
}
