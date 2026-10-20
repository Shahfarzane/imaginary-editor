/** A press hides a rail button's tooltip until the pointer leaves it, so the tip never sits over what the click opened. */
export const tipOff = {
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
    e.currentTarget.dataset.tipoff = ''
  },
  onPointerLeave: (e: React.PointerEvent<HTMLElement>) => {
    delete e.currentTarget.dataset.tipoff
  },
}
