import { useEffect, useRef, useState } from 'react'
import s from './PresetStrip.module.css'

/** A name field and its buttons: Enter saves, Escape or a press anywhere else closes it; deleting takes two clicks. */
export function NameEditor({
  field,
  initial,
  saveLabel,
  deleteLabel,
  onSubmit,
  onDelete,
  onClose,
}: {
  /** The field's accessible name. */
  field: string
  initial: string
  saveLabel: string
  /** Names what the Delete button removes; without it there is no Delete. */
  deleteLabel?: string
  onSubmit: (name: string) => unknown
  onDelete?: () => unknown
  onClose: () => void
}) {
  const [name, setName] = useState(initial)
  const [confirm, setConfirm] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose()
    window.addEventListener('pointerdown', down)
    return () => window.removeEventListener('pointerdown', down)
  }, [onClose])

  const submit = async () => {
    await onSubmit(name)
    onClose()
  }
  const remove = async () => {
    if (!confirm) return setConfirm(true)
    await onDelete?.()
    onClose()
  }

  return (
    <div ref={box} className={s.editor} role="dialog" aria-label={saveLabel}>
      <input
        className={s.input}
        aria-label={field}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onClose()
        }}
      />
      <button className={s.action} onClick={() => void submit()}>
        {saveLabel}
      </button>
      {deleteLabel && onDelete && (
        <button
          className={`${s.action} ${s.danger}`}
          aria-label={confirm ? `Delete ${deleteLabel} for good` : `Delete ${deleteLabel}`}
          onClick={() => void remove()}
        >
          {confirm ? 'Delete for good' : 'Delete'}
        </button>
      )}
    </div>
  )
}
