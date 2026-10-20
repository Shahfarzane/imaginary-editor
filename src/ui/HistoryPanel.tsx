import s from './Panel.module.css'
import h from './HistoryPanel.module.css'
import { useLibrary } from '../store/library'
import { Slider } from './Slider'

/** Undo stack as a scrubbable timeline plus a clickable list of steps. */
export function HistoryPanel() {
  const past = useLibrary((st) => st.past)
  const future = useLibrary((st) => st.future)
  const jumpTo = useLibrary((st) => st.jumpTo)
  const total = past.length + future.length
  if (!total) return null
  // Steps in chronological order: applied ones, then the redo stack (reversed).
  const steps = [...past.map((e) => ({ label: e.label, done: true })), ...[...future].reverse().map((e) => ({ label: e.label, done: false }))]
  return (
    <div className={s.group}>
      <div className={s.groupTitle}>History</div>
      <Slider label="Timeline" value={past.length / total} bipolar={false} scale={total} onChange={(v) => jumpTo(v * total)} />
      <ol className={h.list}>
        <li className={past.length === 0 ? h.cur : ''} onClick={() => jumpTo(0)}>
          Original
        </li>
        {steps.map((st, i) => (
          <li key={i} className={`${st.done ? '' : h.undone} ${i + 1 === past.length ? h.cur : ''}`} onClick={() => jumpTo(i + 1)}>
            {st.label}
          </li>
        ))}
      </ol>
    </div>
  )
}
