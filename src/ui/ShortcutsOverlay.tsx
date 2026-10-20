import s from './ShortcutsOverlay.module.css'
import { useUi } from './uiState'
import { SHORTCUTS } from './useShortcuts'
import * as I from './icons'

/** Each key in a shortcut as a keycap; "…" and "(hold)" stay plain text. */
function Keys({ keys }: { keys: string }) {
  return (
    <dt className={s.keys}>
      {keys.split(/\s+/).map((k, i) =>
        k === '…' || k.startsWith('(') ? (
          <span key={i} className={s.aside}>
            {k}
          </span>
        ) : (
          <kbd key={i} className={s.key}>
            {k}
          </kbd>
        ),
      )}
    </dt>
  )
}

export function ShortcutsOverlay() {
  const open = useUi((u) => u.shortcuts)
  const set = useUi((u) => u.setShortcuts)
  if (!open) return null
  return (
    <div role="dialog" aria-label="Keyboard shortcuts" className={s.overlay}>
      <div className={s.head}>
        Shortcuts
        <button className={s.close} aria-label="Close" onClick={() => set(false)}>
          <I.Close width={16} />
        </button>
      </div>
      <dl className={s.list}>
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <Keys keys={k} />
            <dd className={s.does}>{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
