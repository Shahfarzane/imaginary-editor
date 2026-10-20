import { linearToOklab, linearToSrgb, oklabToLinear, srgbToLinear } from '../engine/color'

/** CSS rgb() for an Oklch color, gamut-clipped by reducing chroma. */
export function oklch(L: number, C: number, hDeg: number): string {
  const h = (hDeg * Math.PI) / 180
  for (let c = C; c >= 0; c -= 0.01) {
    const lin = oklabToLinear([L, c * Math.cos(h), c * Math.sin(h)])
    if (lin.every((v) => v >= -0.001 && v <= 1.001) || c <= 0.01) {
      const [r, g, b] = lin.map((v) => Math.round(Math.min(1, Math.max(0, linearToSrgb(v))) * 255))
      return `rgb(${r}, ${g}, ${b})`
    }
  }
  return 'rgb(128,128,128)'
}

export function hueTrack(L: number, C: number) {
  const stops = Array.from({ length: 13 }, (_, i) => oklch(L, C, i * 30))
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

/**
 * A chip color as a pill fill: the hue kept, lightness capped so
 * white text sits on it (fills land around L 0.3 to 0.5), near-grays a charcoal.
 */
export function pillFill(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const [L, a, b] = linearToOklab([n >> 16, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255)) as [number, number, number])
  const C = Math.hypot(a, b)
  return oklch(Math.min(L, C < 0.03 ? 0.4 : 0.52), Math.min(C, 0.16), (Math.atan2(b, a) * 180) / Math.PI)
}
