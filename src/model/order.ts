// Orders the user rearranges (strip groups, the presets in a set or a collection): small list moves, and saved
// orders reconciled with what exists now.

/** Moves `item` next to `target`: before it, or after it when `after` is set. Unknown targets leave the order alone. */
export function moveItem<T>(order: T[], item: T, target: T, after: boolean): T[] {
  if (item === target) return order
  const out = order.filter((x) => x !== item)
  const i = out.indexOf(target)
  if (i < 0) return order
  out.splice(after ? i + 1 : i, 0, item)
  return out
}

/** Puts `item` next to `target` whether or not the order has it yet; at the end when the target is unknown. */
export function placeItem<T>(order: T[], item: T, target: T | null, after: boolean): T[] {
  const out = order.filter((x) => x !== item)
  const i = target === null ? -1 : out.indexOf(target)
  if (i < 0) return [...out, item]
  out.splice(after ? i + 1 : i, 0, item)
  return out
}

/**
 * A saved order, cleaned: unknown items and duplicates dropped, items it does not know (added since) slotted in after
 * the nearest earlier item the saved order already has, else first.
 */
export function normalizeOrder<T>(saved: T[], all: T[]): T[] {
  const known = new Set(all)
  const out: T[] = []
  const seen = new Set<T>()
  for (const x of saved)
    if (known.has(x) && !seen.has(x)) {
      out.push(x)
      seen.add(x)
    }
  all.forEach((x, i) => {
    if (seen.has(x)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(all[j])
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, x)
    seen.add(x)
  })
  return out
}
