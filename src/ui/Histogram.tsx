import { useEffect, useRef } from 'react'
import { useHist } from './histData'

// The panel's content width: 260 minus its 1px rule and 12px padding on each side.
const WIDTH = 235

/** RGB histogram drawn additively, like a scope. */
export function Histogram() {
  const hist = useHist((h) => h.hist)
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !hist) return
    const dpr = window.devicePixelRatio || 1
    const W = WIDTH
    const H = 56
    c.width = W * dpr
    c.height = H * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, W, H)
    ctx.globalCompositeOperation = 'lighter'
    const draw = (bins: Uint32Array, color: string) => {
      ctx.beginPath()
      ctx.moveTo(0, H)
      for (let i = 0; i < 256; i++) {
        const v = Math.min(1, Math.sqrt(bins[i] / hist.max))
        ctx.lineTo((i / 255) * W, H - v * H)
      }
      ctx.lineTo(W, H)
      ctx.closePath()
      ctx.fillStyle = color
      ctx.fill()
    }
    draw(hist.r, 'rgba(230, 60, 60, 0.55)')
    draw(hist.g, 'rgba(60, 200, 90, 0.55)')
    draw(hist.b, 'rgba(70, 110, 255, 0.55)')
  }, [hist])
  return <canvas ref={ref} style={{ width: WIDTH, height: 56, display: 'block', opacity: hist ? 1 : 0, transition: 'opacity .3s' }} aria-label="Histogram" />
}
