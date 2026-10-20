import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import s from './PresetStrip.module.css'
import * as I from './icons'
import { tileByCode } from '../model/presetOrder'
import { useCollections } from '../store/collections'
import { isCustomOrder, useStripOrder } from '../store/stripOrder'
import { NameEditor } from './NameEditor'

/** Where the menu opened and the presets it acts on: the one right-clicked, or every picked one. */
export type MenuAt = { x: number; y: number; codes: string[] }

/**
 * A preset's right-click menu: a check for each collection that has it (a click adds or takes it out), a new
 * collection with it, and a way back to the catalog's order once the strip has been rearranged.
 */
export function StripMenu({ at, onClose, onAction }: { at: MenuAt; onClose: () => void; onAction: () => void }) {
  const list = useCollections((c) => c.list)
  const custom = useStripOrder(isCustomOrder)
  const [naming, setNaming] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, bottom: window.innerHeight - at.y + 4 })

  // Above the pointer, inside the window.
  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect()
    setPos({ left: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), bottom: Math.max(8, window.innerHeight - at.y + 4) })
  }, [at])
  // A press elsewhere, Escape, or the window losing focus closes it; Escape goes no further.
  useEffect(() => {
    const down = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const C = useCollections.getState()
  const done = () => {
    onAction()
    onClose()
  }
  const one = at.codes.length === 1 ? tileByCode(at.codes[0]) : null
  const title = one ? `${one.code} ${one.name}` : `${at.codes.length} presets`
  return (
    <div
      ref={box}
      className={s.menu}
      role="menu"
      aria-label={`Menu for ${title}`}
      style={{ left: pos.left, bottom: pos.bottom }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className={s.menuHead}>{title}</div>
      {list.length > 0 && <div className={s.menuSection}>Collections</div>}
      {list.map((c) => {
        const has = at.codes.every((code) => c.codes.includes(code))
        return (
          <button
            key={c.id}
            role="menuitemcheckbox"
            aria-checked={has}
            className={s.menuItem}
            onClick={() => {
              if (has) C.drop(c.id, at.codes)
              else C.add(c.id, at.codes)
              done()
            }}
          >
            <span className={s.menuIcon}>{has && <I.Check />}</span>
            {c.name}
          </button>
        )
      })}
      {naming ? (
        <NameEditor
          field="Collection name"
          initial={`Collection ${list.length + 1}`}
          saveLabel="Create"
          onSubmit={(name) => {
            C.create(name, at.codes)
            onAction()
          }}
          onClose={onClose}
        />
      ) : (
        <button role="menuitem" className={s.menuItem} onClick={() => setNaming(true)}>
          <span className={s.menuIcon}>
            <I.Add width={14} />
          </span>
          New collection…
        </button>
      )}
      {custom && (
        <>
          <div className={s.menuSep} />
          <button
            role="menuitem"
            className={s.menuItem}
            onClick={() => {
              useStripOrder.getState().reset()
              onClose()
            }}
          >
            <span className={s.menuIcon} />
            Reset strip order
          </button>
        </>
      )}
    </div>
  )
}
