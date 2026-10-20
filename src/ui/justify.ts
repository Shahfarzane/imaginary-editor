/** One laid-out row: the items it holds (by index), its height, and each item's width. */
export interface JustifiedRow {
  items: number[]
  height: number
  widths: number[]
}

/**
 * Packs photos into rows that fill `width` edge to edge, each photo at its own aspect ratio (width /
 * height), with rows as close to `target` tall as the breaks allow and no taller than `maxHeight`
 * where a break allows it. The last row keeps the target height instead of stretching. Widths are
 * whole pixels that add up to the row exactly.
 */
export function justify(aspects: number[], width: number, target: number, gap: number, maxHeight = Infinity): JustifiedRow[] {
  const rows: JustifiedRow[] = []
  const fit = (sum: number, n: number) => (width - gap * (n - 1)) / sum
  let start = 0
  let sum = 0
  for (let i = 0; i < aspects.length; i++) {
    const a = Math.max(0.05, aspects[i] || 1)
    const n = i - start + 1
    const h = fit(sum + a, n)
    if (h > target) {
      sum += a
      continue
    }
    // This photo overfills the row. End the row with it or before it, whichever lands nearer the target,
    // unless ending before it leaves a row taller than the view (a pair of tall portraits at a large size).
    const without = n > 1 ? fit(sum, n - 1) : Infinity
    if (without <= maxHeight && Math.abs(without - target) < Math.abs(h - target)) {
      rows.push(row(aspects, start, i, without, width, gap))
      start = i
      sum = a
    } else {
      rows.push(row(aspects, start, i + 1, h, width, gap))
      start = i + 1
      sum = 0
    }
  }
  if (start < aspects.length) rows.push(row(aspects, start, aspects.length, Math.min(target, fit(sum, aspects.length - start)), width, gap, true))
  return rows
}

function row(aspects: number[], from: number, to: number, height: number, width: number, gap: number, last = false): JustifiedRow {
  const items = Array.from({ length: to - from }, (_, k) => from + k)
  const h = Math.max(1, Math.round(height))
  const exact = items.map((i) => Math.max(0.05, aspects[i] || 1) * height)
  let widths = exact.map((w) => Math.max(1, Math.round(w)))
  if (!last) {
    // Hand the rounding error to the widest photo so the row ends flush with the edge.
    const room = width - gap * (items.length - 1)
    const diff = room - widths.reduce((a, b) => a + b, 0)
    const k = widths.indexOf(Math.max(...widths))
    widths = widths.map((w, j) => (j === k ? Math.max(1, w + diff) : w))
  }
  return { items, height: h, widths }
}
