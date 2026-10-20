import { useLibrary } from '../store/library'
import s from './Toasts.module.css'

export function Toasts() {
  const toasts = useLibrary((st) => st.toasts)
  const importing = useLibrary((st) => st.importing)
  return (
    <div className={s.wrap} aria-live="polite">
      {importing > 0 && <div className={s.toast}>Importing {importing}…</div>}
      {toasts.map((t) => (
        <div key={t.id} className={s.toast}>
          {t.text}
        </div>
      ))}
    </div>
  )
}
