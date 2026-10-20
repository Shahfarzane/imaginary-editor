import { useMemo, useRef, useState } from 'react'
import s from './CurveEditor.module.css'
import ps from './Panel.module.css'
import { activePhoto, useLibrary } from '../store/library'
import { identityCurve, isCurveIdentity, type CurveChannel, type CurvePoint } from '../model/edit'
import { monotoneSpline } from '../engine/color'
import { useHist } from './histData'

const CH: { id: CurveChannel; label: string; color: string }[] = [
  { id: 'rgb', label: 'RGB', color: '#fff' },
  { id: 'r', label: 'R', color: '#ff5b5b' },
  { id: 'g', label: 'G', color: '#4ad66d' },
  { id: 'b', label: 'B', color: '#4f8bff' },
]
const SIZE = 228

export function CurveEditor() {
  const [ch, setCh] = useState<CurveChannel>('rgb')
  const photo = useLibrary(activePhoto)
  const update = useLibrary((st) => st.updateEdits)
  const begin = useLibrary((st) => st.begin)
  const commit = useLibrary((st) => st.commit)
  const hist = useHist((h) => h.hist)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<number | null>(null)

  const points = photo?.edit.curves[ch] ?? identityCurve()
  const color = CH.find((c) => c.id === ch)!.color

  const path = useMemo(() => {
    const ys = monotoneSpline(points, 97)
    return Array.from(ys, (y, i) => `${i ? 'L' : 'M'}${((i / 96) * SIZE).toFixed(1)},${((1 - Math.min(1, Math.max(0, y))) * SIZE).toFixed(1)}`).join('')
  }, [points])

  const histPath = useMemo(() => {
    if (!hist) return ''
    const bins = ch === 'rgb' ? hist.l : hist[ch]
    const max = Math.max(1, ...Array.from(bins).slice(2, 254))
    let d = `M0,${SIZE}`
    for (let i = 0; i < 256; i++) d += `L${((i / 255) * SIZE).toFixed(1)},${(SIZE - Math.min(1, bins[i] / max) * SIZE * 0.9).toFixed(1)}`
    return d + `L${SIZE},${SIZE}Z`
  }, [hist, ch])

  const toLocal = (e: React.PointerEvent): CurvePoint => {
    const r = svg.current!.getBoundingClientRect()
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))]
  }

  const setPoints = (pts: CurvePoint[]) =>
    update((ed) => {
      ed.curves[ch] = pts
      return ed
    }, 'Curve')

  const onDown = (e: React.PointerEvent) => {
    if (!photo) return
    svg.current!.setPointerCapture(e.pointerId)
    const [x, y] = toLocal(e)
    const hit = points.findIndex((p) => Math.hypot((p[0] - x) * SIZE, (p[1] - y) * SIZE) < 10)
    begin('Curve')
    if (hit >= 0) {
      drag.current = hit
      return
    }
    // Add a point on the curve under the cursor's x, snapped to the pointer y.
    const next = [...points, [x, y] as CurvePoint].sort((a, b) => a[0] - b[0])
    drag.current = next.findIndex((p) => p[0] === x && p[1] === y)
    setPoints(next)
  }
  const onMove = (e: React.PointerEvent) => {
    const i = drag.current
    if (i === null) return
    let [x, y] = toLocal(e)
    const pts = points.map((p) => [...p] as CurvePoint)
    const last = pts.length - 1
    if (i === 0) x = Math.min(x, pts[1][0] - 0.02)
    else if (i === last) x = Math.max(x, pts[last - 1][0] + 0.02)
    else x = Math.min(Math.max(x, pts[i - 1][0] + 0.02), pts[i + 1][0] - 0.02)
    // Dragging an inner point far outside removes it.
    if (i > 0 && i < last && (e.clientY < svg.current!.getBoundingClientRect().top - 30 || e.clientY > svg.current!.getBoundingClientRect().bottom + 30)) {
      pts.splice(i, 1)
      drag.current = null
      setPoints(pts)
      return
    }
    pts[i] = [x, y]
    setPoints(pts)
  }
  const onUp = () => {
    drag.current = null
    commit()
  }

  const anyChanged = photo && (['rgb', 'r', 'g', 'b'] as const).some((c) => !isCurveIdentity(photo.edit.curves[c]))

  return (
    <div className={s.wrap}>
      <div className={s.tabs}>
        <div className={ps.seg} style={{ flex: 1 }}>
          {CH.map((c) => (
            <button key={c.id} aria-pressed={ch === c.id} onClick={() => setCh(c.id)} style={ch === c.id ? { color: c.color } : undefined}>
              {c.label}
            </button>
          ))}
        </div>
        {anyChanged && (
          <button
            className={s.reset}
            onClick={() =>
              update((ed) => {
                ed.curves = { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() }
                return ed
              }, 'Reset curves')
            }
          >
            Reset
          </button>
        )}
      </div>
      <svg
        ref={svg}
        className={s.svg}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={(e) => {
          const [x, y] = toLocal(e as unknown as React.PointerEvent)
          const hit = points.findIndex((p, i) => i > 0 && i < points.length - 1 && Math.hypot((p[0] - x) * SIZE, (p[1] - y) * SIZE) < 10)
          if (hit > 0) setPoints(points.filter((_, i) => i !== hit))
        }}
      >
        {histPath && <path d={histPath} className={s.hist} />}
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} className={s.grid}>
            <line x1={g * SIZE} y1={0} x2={g * SIZE} y2={SIZE} />
            <line x1={0} y1={g * SIZE} x2={SIZE} y2={g * SIZE} />
          </g>
        ))}
        <line x1={0} y1={SIZE} x2={SIZE} y2={0} className={s.diag} />
        <path d={path} fill="none" stroke={color} strokeWidth={1.5} />
        {points.map((p, i) => (
          <circle key={i} cx={p[0] * SIZE} cy={(1 - p[1]) * SIZE} r={4.5} className={s.pt} style={{ stroke: color }} />
        ))}
      </svg>
      <div className={ps.hint}>Click to add a point, drag it out to remove.</div>
    </div>
  )
}
