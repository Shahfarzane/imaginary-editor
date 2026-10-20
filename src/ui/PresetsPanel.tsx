import { useCallback, useEffect, useMemo, useState } from 'react'
import t from './PresetsPanel.module.css'
import { pasteEdit } from '../model/edit'
import { familyOf, getPreset } from '../model/presets'
import { PRESET_COLORS } from '../model/presetColors'
import { tileByCode } from '../model/presetOrder'
import type { StripTile } from '../model/strip'
import { activePhoto, useLibrary } from '../store/library'
import { presetEdit, useUserPresets } from '../store/userPresets'
import { useCollections } from '../store/collections'
import { orderedGroups, useStripOrder } from '../store/stripOrder'
import { usePreview } from './preview'
import { pillFill } from './colorui'
import { applyPreset, useCurrentTile } from './presetActions'
import { StripMenu, type MenuAt } from './StripMenu'

/**
 * The Presets panel in the right sidebar (a setting): the presets as a list in the strip's order, your saved presets,
 * your collections and the catalog's sets, one row per preset with its code on a chip. Click applies, hover previews,
 * right-click opens the collections menu.
 */
export function PresetsPanel() {
  const photo = useLibrary(activePhoto)
  const count = useLibrary((st) => st.selected.length)
  const current = useCurrentTile()
  const collections = useCollections((c) => c.list)
  const groupOrder = useStripOrder((o) => o.groups)
  const setOrders = useStripOrder((o) => o.sets)
  const groups = useMemo(() => orderedGroups(collections, { groups: groupOrder, sets: setOrders }), [collections, groupOrder, setOrders])
  const saved = useUserPresets((u) => u.list)
  const load = useUserPresets((u) => u.load)
  const savedCurrent = useMemo(() => (photo ? JSON.stringify(presetEdit(photo.edit)) : ''), [photo])
  const [menu, setMenu] = useState<MenuAt | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const disabled = count === 0

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className={`${t.list} ${disabled ? t.disabled : ''}`}>
        {saved.length > 0 && (
          <section>
            <h3 className={t.groupTitle}>Your presets</h3>
            {saved.map((r, i) => (
              <div key={r.id} className={t.lut}>
                <button
                  className={`${t.row} ${savedCurrent === JSON.stringify(r.edit) ? t.sel : ''}`}
                  aria-disabled={disabled}
                  aria-label={`list preset ${r.name}`}
                  onClick={() => !disabled && useLibrary.getState().updateEdits((e) => pasteEdit(e, r.edit), `Preset ${r.name}`)}
                >
                  <span className={`${t.pill} ${t.none}`}>U{i + 1}</span>
                  <span className={t.name}>{r.name}</span>
                </button>
              </div>
            ))}
          </section>
        )}
        {groups.map((g) => (
          <section key={g.key}>
            <h3 className={t.groupTitle}>{g.collection?.name ?? g.key}</h3>
            {g.codes.map((code) => {
              const tile = tileByCode(code)!
              const selected = current === code
              return (
                <Row
                  key={code}
                  tile={tile}
                  selected={selected}
                  disabled={disabled}
                  onClick={() => !disabled && applyPreset(selected ? null : tile)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, codes: [code] })
                  }}
                />
              )
            })}
          </section>
        ))}
      {menu && <StripMenu at={menu} onClose={closeMenu} onAction={() => {}} />}
    </div>
  )
}

/** Film stocks are light chips with colored text; the others a deep fill with white text. Studio tiles get a gold ring. */
function Row({
  tile,
  selected,
  disabled,
  onClick,
  onContextMenu,
}: {
  tile: StripTile
  selected: boolean
  disabled: boolean
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
}) {
  const setPreview = usePreview((p) => p.set)
  const preset = getPreset(tile.look)!
  const color = PRESET_COLORS[preset.code] ?? familyOf(preset).color
  const stock = familyOf(preset).chip === 'stock'
  return (
    <div className={t.lut}>
      <button
        className={`${t.row} ${selected ? t.sel : ''}`}
        aria-pressed={selected}
        aria-disabled={disabled}
        aria-label={`list preset ${tile.code}: ${tile.name}`}
        title={tile.full}
        onPointerEnter={() => !disabled && !selected && setPreview(tile.look)}
        onPointerLeave={() => setPreview(null)}
        onClick={() => {
          setPreview(null)
          onClick()
        }}
        onContextMenu={onContextMenu}
      >
        <span
          className={`${t.pill} ${stock ? t.stock : ''} ${tile.pro ? t.pro : ''}`}
          style={{ '--c': stock ? color : pillFill(color) } as React.CSSProperties}
        >
          {tile.code}
        </span>
        <span className={t.name}>{tile.name}</span>
      </button>
    </div>
  )
}
