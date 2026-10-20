// Engine timings in whatever browser opens `?bench`, on a synthetic 24 MP photo. It never touches the library:
// the photo is drawn here and fed straight to the renderer. Results print on the page (and to the console).
import { useEffect, useState } from 'react'
import { getRenderer } from './store/render'
import { defaultEdit, type Edit } from './model/edit'
import { loadAllSliders } from './model/presets'
import { toolTablesLoaded } from './model/toolData'

const RUNS = 9

function syntheticPhoto(W: number, H: number): OffscreenCanvas {
  const c = new OffscreenCanvas(W, H)
  const g = c.getContext('2d')!
  const sky = g.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#6f9fd8')
  sky.addColorStop(0.55, '#e8d2b0')
  sky.addColorStop(1, '#2f4a2a')
  g.fillStyle = sky
  g.fillRect(0, 0, W, H)
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `hsl(${(i * 47) % 360} 60% ${30 + (i % 40)}%)`
    g.beginPath()
    g.arc((i * 7919) % W, (i * 104729) % H, 20 + (i % 90), 0, Math.PI * 2)
    g.fill()
  }
  return c
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function run(log: (line: string) => void) {
  const r = getRenderer()
  if (!r) return log('WebGL2 unavailable')
  await Promise.all([loadAllSliders(), toolTablesLoaded])
  const gl = r.gl
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  log(navigator.userAgent)
  log(`GPU: ${info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`)
  const full = syntheticPhoto(6000, 4000)
  const proxy = await createImageBitmap(full, { resizeWidth: 2560, resizeHeight: 1707, resizeQuality: 'high' })
  const src = r.loadSource(proxy)
  const px = new Uint8Array(4)
  const base = (): Edit => {
    const e = defaultEdit(7)
    e.preset.id = 'lb1'
    e.tools.clarity = 0.4
    e.tools.shadows = 0.3
    e.fx.grain = 0.5
    e.fx.halation = 0.4
    return e
  }
  const time = (label: string, W: number, H: number, mutate: (e: Edit, i: number) => void) => {
    const ts: number[] = []
    for (let i = 0; i < RUNS; i++) {
      const e = base()
      mutate(e, i)
      const t0 = performance.now()
      const b = r.renderBitmap(src, e, W, H)
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px) // wait for the GPU
      ts.push(performance.now() - t0)
      b.close()
    }
    log(`${label.padEnd(34)} ${median(ts).toFixed(1).padStart(7)} ms`)
  }
  const looks = ['lb1', 'lb2', 'lb3', 'lb4']
  for (const [W, H] of [
    [2560, 1440],
    [Math.round(screen.width * devicePixelRatio), Math.round(screen.height * devicePixelRatio)],
  ]) {
    log(`preview ${W}x${H}`)
    time('  tool slider (bake + develop)', W, H, (e, i) => (e.tools.exposure = i * 0.01))
    time('  grain slider (develop only)', W, H, (e, i) => (e.fx.grain = 0.3 + i * 0.01))
    time('  crop drag (geometry + filters)', W, H, (e, i) => (e.crop.x = i * 0.001))
    time('  preset switch', W, H, (e, i) => (e.preset.id = looks[i % looks.length]))
  }
  const fullSrc = r.loadSource(await createImageBitmap(full))
  const t0 = performance.now()
  await r.renderPixels(fullSrc, base(), 6000, 4000)
  log(`full export 6000x4000 (24 MP)       ${(performance.now() - t0).toFixed(0).padStart(7)} ms`)
  r.deleteSource(fullSrc)
  r.deleteSource(src)
  log('done')
}

export default function Bench() {
  const [lines, setLines] = useState<string[]>(['running...'])
  useEffect(() => {
    const out: string[] = []
    const log = (l: string) => {
      console.log(l)
      out.push(l)
      setLines([...out])
    }
    // Let the page paint first so the result reads as a page, not a hang.
    const t = setTimeout(() => void run(log).catch((e: Error) => log('error: ' + e.message)), 300)
    return () => clearTimeout(t)
  }, [])
  return (
    <pre style={{ margin: 0, padding: 24, font: '15px/1.5 ui-monospace, monospace', color: '#fff', background: '#000', minHeight: '100vh' }}>
      Imaginary engine benchmark{'\n\n'}
      {lines.join('\n')}
    </pre>
  )
}
