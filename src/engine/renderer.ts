import vert from './shaders/fullscreen.vert?raw'
import bakeFrag from './shaders/bake.frag?raw'
import geometryFrag from './shaders/geometry.frag?raw'
import gfPrepFrag from './shaders/gf_prep.frag?raw'
import boxFrag from './shaders/box.frag?raw'
import gfCoefFrag from './shaders/gf_coef.frag?raw'
import glowPrepFrag from './shaders/glow_prep.frag?raw'
import downFrag from './shaders/down.frag?raw'
import upFrag from './shaders/up.frag?raw'
import developFrag from './shaders/develop.frag?raw'
import {
  bindTex,
  compileProgram,
  createTex,
  deleteTex,
  fboFor,
  setUniforms,
  type GL,
  type Program,
  type Tex,
} from './gl'
import { buildRenderSpec, CURVE_ROWS, GLOW_LEVELS, TOOL_GRID_ROWS, type LookResolver, type RenderSpec } from './params'
import { IDENTITY3, LOOK_CURVE_SIZE, P3_TO_SRGB, SRGB_TO_P3, apply, mul, type Mat3 } from './color'
import { GRID_C, GRID_HUES, GRID_L, LATTICE_MAX_N, MAX_POST_TERMS, POST_C, POST_HUES, POST_L } from './look'
import { cropPixelSize, fitLongEdge, outputToSource, tileMatrix } from './geometry'
import { downsampleLinear, isLinear, linearImage, type LinearImage } from './linear'
import { exportTiles, type PixelRect } from './sourceTiles'
import type { Edit } from '../model/edit'

export const LUT_SIZE = 65
/** Outputs up to this long edge render in one pass; bigger ones tile. */
const SINGLE_PASS_MAX = 3072
const TILE_PAD = 4

interface GuidedScale {
  name: 'base' | 'mid' | 'fine'
  res: number
  rFrac: number
  eps: number
}
const SCALES: GuidedScale[] = [
  // eps is in (log2 luminance)^2: edges with more local variance than this
  // are preserved, so detail boosts do not ring along skylines.
  { name: 'base', res: 384, rFrac: 0.035, eps: 0.12 },
  { name: 'mid', res: 640, rFrac: 0.012, eps: 0.2 },
  { name: 'fine', res: 1280, rFrac: 0.0025, eps: 0.06 },
]
const GLOW_RES = 768

/** The color space of a source's pixels: Display P3 for photos color-managed into P3 before upload. */
export type SourceSpace = 'srgb' | 'display-p3'

export interface Source {
  id: number
  tex: Tex
  width: number
  height: number
  space: SourceSpace
  /** Holds channels above white (camera RAW): clamped at the output's white after the local tone tools, which can recover them. */
  headroom: boolean
  /** The renderer whose context holds the texture: a source does not outlive a lost context. */
  owner: Renderer
  /** Deleted (deleteSource): its texture is gone. */
  released?: boolean
  /** Original CPU pixels retained by export while source regions are uploaded. Owned by the caller. */
  original?: SourceImage
  /** This texture's region in the original image's normalized coordinates. */
  region?: [number, number, number, number]
}

export type SourceImage = (TexImageSource & { width: number; height: number }) | LinearImage

let sourceIds = 0

/** A source drawn after it was deleted (a newer one replaced it): refused, where its gone texture would draw black. */
export class ReleasedSourceError extends Error {
  constructor() {
    super('photo source released')
    this.name = 'ReleasedSourceError'
  }
}

/** The renderer's GPU context is gone (lost, or the renderer retired): its work rejects with this instead of hanging. */
export class ContextLostError extends Error {
  constructor() {
    super('GPU context lost, try again')
    this.name = 'ContextLostError'
  }
}

export class Renderer {
  readonly canvas: OffscreenCanvas
  readonly gl: GL
  private p!: Record<
    'bake' | 'geometry' | 'gfPrep' | 'box' | 'gfCoef' | 'glowPrep' | 'down' | 'up' | 'develop',
    Program
  >
  private vao: WebGLVertexArrayObject
  private lut: WebGLTexture
  private lutFbo: WebGLFramebuffer
  private lutKey = ''
  private exportLock: Promise<void> = Promise.resolve()
  private curves: Tex
  private grid: Tex
  private gridIn: Tex
  private postGrid: Tex
  private postGridIn: Tex
  private terms: Tex
  /**
   * Pro term cache: each term's look over the LUT lattice (RGBA32F, depth LUT_SIZE per slot), so a slider moving inside
   * a cell of captured states only reblends. termSlots holds each slot's key.
   */
  private termLut: WebGLTexture | null = null
  private termSlots: (string | null)[] = []
  private termUsed: number[] = []
  private termTick = 0
  private termLast = new Set<string>()
  private termOff = false
  private toolGrids: Tex
  private lattice: Tex
  private baseLattice: Tex
  private black: Tex
  private slots = new Map<string, Tex>()
  private cacheKeys = new Map<string, string>()
  readonly floatTargets: boolean
  /** Half-float color buffers (or full float): what the guided filter behind the local tone tools needs. */
  readonly halfTargets: boolean
  private resolve: LookResolver
  private retired = false

  static create(resolve: LookResolver): Renderer | null {
    const canvas = new OffscreenCanvas(16, 16)
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as GL | null
    if (!gl) return null
    return new Renderer(canvas, gl, resolve)
  }

  private constructor(canvas: OffscreenCanvas, gl: GL, resolve: LookResolver) {
    this.canvas = canvas
    this.gl = gl
    this.resolve = resolve
    this.floatTargets = !!gl.getExtension('EXT_color_buffer_float')
    this.halfTargets = this.floatTargets || !!gl.getExtension('EXT_color_buffer_half_float')
    gl.getExtension('OES_texture_float_linear')
    const mk = (name: string, frag: string) => compileProgram(gl, vert, frag, name)
    this.p = {
      bake: mk('bake', bakeFrag),
      geometry: mk('geometry', geometryFrag),
      gfPrep: mk('gf_prep', gfPrepFrag),
      box: mk('box', boxFrag),
      gfCoef: mk('gf_coef', gfCoefFrag),
      glowPrep: mk('glow_prep', glowPrepFrag),
      down: mk('down', downFrag),
      up: mk('up', upFrag),
      develop: mk('develop', developFrag),
    }
    this.vao = gl.createVertexArray()!

    // 32-bit floats: half floats would hold the look to about 11 bits, short of a 16-bit export. Read with
    // texelFetch only, so no float filtering is needed.
    const lutFmt = this.floatTargets ? gl.RGBA32F : gl.RGBA8
    this.lut = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_3D, this.lut)
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      lutFmt,
      LUT_SIZE,
      LUT_SIZE,
      LUT_SIZE,
      0,
      gl.RGBA,
      this.floatTargets ? gl.FLOAT : gl.UNSIGNED_BYTE,
      null,
    )
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST)
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
      gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE)
    this.lutFbo = gl.createFramebuffer()!

    this.curves = createTex(gl, LOOK_CURVE_SIZE, CURVE_ROWS, gl.R32F, { filter: 'nearest' })
    this.grid = createTex(gl, GRID_HUES * GRID_C.length, GRID_L.length, gl.RGBA32F, { filter: 'nearest' })
    this.gridIn = createTex(gl, GRID_HUES * GRID_C.length, GRID_L.length, gl.RGBA32F, { filter: 'nearest' })
    // One block of POST_L rows per stage: the post stage's, or each Pro term's.
    this.postGrid = createTex(gl, POST_HUES * POST_C.length, POST_L.length * MAX_POST_TERMS, gl.RGBA32F, {
      filter: 'nearest',
    })
    this.postGridIn = createTex(gl, POST_HUES * POST_C.length, POST_L.length * MAX_POST_TERMS, gl.RGBA32F, {
      filter: 'nearest',
    })
    this.terms = createTex(gl, MAX_POST_TERMS, 3, gl.RGBA32F, { filter: 'nearest' })
    this.toolGrids = createTex(gl, GRID_HUES * GRID_C.length, TOOL_GRID_ROWS, gl.RGBA32F, { filter: 'nearest' })
    this.lattice = createTex(gl, LATTICE_MAX_N * LATTICE_MAX_N, LATTICE_MAX_N, gl.RGBA32F, { filter: 'nearest' })
    this.baseLattice = createTex(gl, LATTICE_MAX_N * LATTICE_MAX_N, LATTICE_MAX_N, gl.RGBA32F, { filter: 'nearest' })
    // All-zero, including alpha: halation lives in the glow alpha channel.
    this.black = createTex(gl, 1, 1, gl.RGBA8, { data: new Uint8Array([0, 0, 0, 0]) })
  }

  get workFormat() {
    return this.floatTargets ? this.gl.RGBA16F : this.gl.RGBA8
  }

  /** Its context is lost (every GPU object with it) or the renderer was retired: nothing it draws or reads is real. */
  get lost() {
    return this.retired || this.gl.isContextLost()
  }

  /** Stop for good: reads in flight and waiting reject, new work is refused. For a renderer being replaced. */
  retire() {
    this.retired = true
  }

  private live() {
    if (this.lost) throw new ContextLostError()
  }

  /** Before drawing from a source: this renderer is live, and the source's texture is in its context and not deleted. */
  private use(src: Source) {
    this.live()
    if (src.owner !== this) throw new ContextLostError()
    if (src.released) throw new ReleasedSourceError()
  }

  // ---------------------------------------------------------------- sources

  /**
   * Upload a photo. `space` is what its pixels are in: Chromium converts uploads to `unpackColorSpace`, so that is
   * set to match; WebKit has no such setting and uploads pixels as they are.
   */
  loadSource(img: SourceImage, space: SourceSpace = 'srgb', maxEdge = Infinity): Source {
    this.live()
    const gl = this.gl
    const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, maxEdge)
    // Half floats in linear light (camera RAW): sampled as they are, no sRGB decode. Mipmaps need a renderable
    // format; without float render targets the texture is filtered without them. Larger than the GPU allows: area
    // averaged to the largest size it takes, still in linear half floats (light above white kept).
    if (isLinear(img)) {
      const lin = downsampleLinear(img, max)
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, lin.width, lin.height, 0, gl.RGBA, gl.HALF_FLOAT, lin.data)
      const mips = this.floatTargets
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      if (mips) gl.generateMipmap(gl.TEXTURE_2D)
      const t = { tex, width: lin.width, height: lin.height, internal: gl.RGBA16F, mips }
      return { id: ++sourceIds, tex: t, width: lin.width, height: lin.height, space, headroom: true, owner: this }
    }
    const [w, h] = fitLongEdge(img.width, img.height, max)
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    const unpack = 'unpackColorSpace' in gl
    if (unpack) gl.unpackColorSpace = space
    if (w === img.width && h === img.height) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img)
    } else {
      // Larger than the GPU allows: downscale through a 2D canvas first.
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d', { colorSpace: space })!
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img as CanvasImageSource, 0, 0, w, h)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, c)
    }
    if (unpack) gl.unpackColorSpace = 'srgb'
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.generateMipmap(gl.TEXTURE_2D)
    return {
      id: ++sourceIds,
      tex: { tex, width: w, height: h, internal: gl.SRGB8_ALPHA8, mips: true },
      width: w,
      height: h,
      space,
      headroom: false,
      owner: this,
    }
  }

  /** Keep original pixels above the texture limit. The reduced texture is only for global effect layers. */
  loadExportSource(img: SourceImage, space: SourceSpace = 'srgb'): Source {
    // Within the limit the whole photo uploads as one texture: reducing it first cost a RAW export about 0.4 s of CPU
    // (24 MP) for no gain in detail.
    if (Math.max(img.width, img.height) <= (this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE) as number))
      return this.loadSource(img, space)
    const src = this.loadSource(img, space, SINGLE_PASS_MAX)
    if (src.width !== img.width || src.height !== img.height) {
      src.original = img
      src.width = img.width
      src.height = img.height
    }
    return src
  }

  private sourceRegion(src: Source, rect: PixelRect): Source {
    const img = src.original!
    const { x, y, width, height } = rect
    let part: SourceImage
    if (isLinear(img)) {
      const data = new Uint16Array(width * height * 4)
      for (let row = 0; row < height; row++) {
        const start = (Math.min(img.height - 1, y + row) * img.width + x) * 4
        const valid = Math.min(width, img.width - x)
        data.set(img.data.subarray(start, start + valid * 4), row * width * 4)
        for (let col = valid; col < width; col++)
          data.set(img.data.subarray(start + (valid - 1) * 4, start + valid * 4), (row * width + col) * 4)
      }
      part = linearImage(width, height, data)
    } else {
      const canvas = new OffscreenCanvas(width, height)
      const ctx = canvas.getContext('2d', { colorSpace: src.space })!
      const validW = Math.min(width, img.width - x),
        validH = Math.min(height, img.height - y)
      ctx.drawImage(img as CanvasImageSource, x, y, validW, validH, 0, 0, validW, validH)
      // Extend the final edge to a mip-aligned size. Every tile then uses the same source-pixel grid.
      if (validW < width)
        ctx.drawImage(img as CanvasImageSource, img.width - 1, y, 1, validH, validW, 0, width - validW, validH)
      if (validH < height) ctx.drawImage(canvas, 0, validH - 1, width, 1, 0, validH, width, height - validH)
      part = canvas
    }
    const tile = this.loadSource(part, src.space)
    tile.region = [x / src.width, y / src.height, width / src.width, height / src.height]
    return tile
  }

  deleteSource(s: Source) {
    s.released = true
    s.original = undefined
    // A source of a lost (replaced) renderer went with its context.
    if (s.owner === this && !this.gl.isContextLost()) this.gl.deleteTexture(s.tex.tex)
  }

  // ---------------------------------------------------------------- slots

  private slot(
    name: string,
    w: number,
    h: number,
    internal: number,
    opts: { mips?: boolean; filter?: 'linear' | 'nearest' } = {},
  ) {
    const key = name
    const cur = this.slots.get(key)
    if (cur && cur.width === w && cur.height === h && cur.internal === internal) return cur
    deleteTex(this.gl, cur)
    const t = createTex(this.gl, w, h, internal, opts)
    this.slots.set(key, t)
    this.cacheKeys.delete(key)
    return t
  }

  private draw(p: Program, target: Tex | null, w: number, h: number) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? fboFor(gl, target) : null)
    gl.viewport(0, 0, w, h)
    gl.useProgram(p.prog)
    gl.bindVertexArray(this.vao)
  }

  /** Tag the canvas's drawing buffer with the space the next on-screen render encodes, so its bitmap carries it. */
  private tagDrawingBuffer(space: SourceSpace) {
    const gl = this.gl
    if ('drawingBufferColorSpace' in gl && gl.drawingBufferColorSpace !== space) gl.drawingBufferColorSpace = space
  }

  private tri() {
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3)
  }

  // ---------------------------------------------------------------- LUT

  private bakeLut(spec: RenderSpec) {
    if (spec.lutKey === this.lutKey) return
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.curves.tex)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LOOK_CURVE_SIZE, CURVE_ROWS, gl.RED, gl.FLOAT, spec.curves)
    for (const [tex, data] of [
      [this.grid, spec.grid],
      [this.gridIn, spec.gridIn],
      [this.postGrid, spec.postGrid],
      [this.postGridIn, spec.postGridIn],
      [this.toolGrids, spec.toolGrids],
      [this.terms, spec.terms],
    ] as const) {
      if (!data) continue
      gl.bindTexture(gl.TEXTURE_2D, tex.tex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tex.width, tex.height, gl.RGBA, gl.FLOAT, data)
    }

    if (spec.lattice) {
      // The lattice occupies the top-left n^2 x n texels; node (r, g, b) at (r + n * g, b).
      const n = spec.latticeN
      gl.bindTexture(gl.TEXTURE_2D, this.lattice.tex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n * n, n, gl.RGBA, gl.FLOAT, spec.lattice)
    }
    if (spec.baseLattice) {
      const n = spec.baseN
      gl.bindTexture(gl.TEXTURE_2D, this.baseLattice.tex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, n * n, n, gl.RGBA, gl.FLOAT, spec.baseLattice)
    }

    const p = this.p.bake
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lutFbo)
    gl.viewport(0, 0, LUT_SIZE, LUT_SIZE)
    gl.useProgram(p.prog)
    gl.bindVertexArray(this.vao)
    bindTex(gl, p, 'uCurves', 0, this.curves.tex)
    bindTex(gl, p, 'uLkGrid', 1, this.grid.tex)
    bindTex(gl, p, 'uLkGridIn', 2, this.gridIn.tex)
    bindTex(gl, p, 'uLkPostGrid', 3, this.postGrid.tex)
    bindTex(gl, p, 'uLkPostGridIn', 4, this.postGridIn.tex)
    bindTex(gl, p, 'uToolGrids', 5, this.toolGrids.tex)
    bindTex(gl, p, 'uLkLattice', 6, this.lattice.tex)
    bindTex(gl, p, 'uLkTerms', 7, this.terms.tex)
    // Unit 8 is the term cache's (3D).
    bindTex(gl, p, 'uLkBaseLattice', 9, this.baseLattice.tex)
    setUniforms(gl, p, { ...spec.bake, uSize: LUT_SIZE, uTermPass: { int: -1 } })
    // The term cache on a unit of its own (a 3D sampler must not share one with the 2D textures), unbound while
    // filling it: a texture both drawn into and bound for the program is a feedback loop.
    bindTex(gl, p, 'uTermLut', 8, null, gl.TEXTURE_3D)
    const slots = this.termCache(spec)
    bindTex(gl, p, 'uTermLut', 8, this.termLut, gl.TEXTURE_3D)
    if (slots) {
      // Where each cached term sits, for the full bake.
      const t = spec.terms!.slice()
      slots.forEach((s, k) => (t[(2 * MAX_POST_TERMS + k) * 4 + 2] = s))
      gl.bindTexture(gl.TEXTURE_2D, this.terms.tex)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.terms.width, this.terms.height, gl.RGBA, gl.FLOAT, t)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lutFbo)
    gl.viewport(0, 0, LUT_SIZE, LUT_SIZE)
    for (let z = 0; z < LUT_SIZE; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.lut, 0, z)
      setUniforms(gl, p, { uLayer: z })
      this.tri()
    }
    this.lutKey = spec.lutKey
  }

  /**
   * Cache slots for this bake's Pro terms (-1: computed inline), filling at most two terms that were also in the last
   * bake: a slider moving inside a cell of captured states, Strength or a tool after the look keep the states and fill
   * the cache over a few frames, while a tool ahead of the look changes every key and never fills. Cached and inline
   * terms are the same numbers (baked at the same lattice point). Null without float targets or the memory and depth for the 3D texture.
   */
  private termCache(spec: RenderSpec): number[] | null {
    const keys = spec.termKeys
    if (!keys || !this.floatTargets || this.termOff) return null
    const gl = this.gl
    if (!this.termLut) {
      if ((gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number) < LUT_SIZE * MAX_POST_TERMS) {
        this.termOff = true
        return null
      }
      this.termLut = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_3D, this.termLut)
      // Storage without data: nothing to upload, and every slot is written before it is read.
      gl.texStorage3D(gl.TEXTURE_3D, 1, gl.RGBA32F, LUT_SIZE, LUT_SIZE, LUT_SIZE * MAX_POST_TERMS)
      for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_3D, p, gl.NEAREST)
      // Off the active unit (the cache's own), which the fills below draw into.
      gl.bindTexture(gl.TEXTURE_3D, null)
      if (gl.getError() === gl.OUT_OF_MEMORY) {
        // About 52 MB: without it every term is computed inline.
        gl.deleteTexture(this.termLut)
        this.termLut = null
        this.termOff = true
        return null
      }
      this.termSlots = Array.from({ length: MAX_POST_TERMS }, () => null)
      this.termUsed = Array.from({ length: MAX_POST_TERMS }, () => 0)
    }
    const tick = ++this.termTick
    const slots = keys.map((k) => this.termSlots.indexOf(k))
    slots.forEach((s) => s >= 0 && (this.termUsed[s] = tick))
    let fills = 0
    keys.forEach((key, k) => {
      if (slots[k] >= 0 || !this.termLast.has(key) || fills >= 2) return
      // The least recently used slot that this bake does not read (there are more slots than terms).
      let s = -1
      for (let i = 0; i < MAX_POST_TERMS; i++)
        if (this.termUsed[i] !== tick && (s < 0 || this.termUsed[i] < this.termUsed[s])) s = i
      this.fillTerm(k, s)
      this.termSlots[s] = key
      this.termUsed[s] = tick
      slots[k] = s
      fills++
    })
    this.termLast = new Set(keys)
    return slots
  }

  /** Bake term k's look into cache slot s (the bake program and this spec's data are bound). */
  private fillTerm(k: number, s: number) {
    const gl = this.gl
    const p = this.p.bake
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lutFbo)
    gl.viewport(0, 0, LUT_SIZE, LUT_SIZE)
    setUniforms(gl, p, { uTermPass: { int: k } })
    for (let z = 0; z < LUT_SIZE; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.termLut!, 0, s * LUT_SIZE + z)
      setUniforms(gl, p, { uLayer: z })
      this.tri()
    }
    setUniforms(gl, p, { uTermPass: { int: -1 } })
  }

  // ---------------------------------------------------------------- passes

  private geometry(src: Source, xform: Mat3, center: [number, number], aberration: number, target: Tex) {
    const gl = this.gl
    const p = this.p.geometry
    this.draw(p, target, target.width, target.height)
    bindTex(gl, p, 'uSource', 0, src.tex.tex)
    setUniforms(gl, p, {
      uXform: xform,
      uSourceRect: src.region ?? [0, 0, 1, 1],
      uAberration: aberration,
      uCenter: center,
      uSourceToWork: src.space === 'display-p3' ? P3_TO_SRGB : IDENTITY3,
    })
    this.tri()
    if (target.mips) {
      gl.bindTexture(gl.TEXTURE_2D, target.tex)
      gl.generateMipmap(gl.TEXTURE_2D)
    }
  }

  private guided(work: Tex, scale: GuidedScale, key: string): Tex {
    const gl = this.gl
    const [w, h] = fitLongEdge(work.width, work.height, Math.min(scale.res, Math.max(work.width, work.height)))
    const r = Math.max(1, Math.min(32, Math.round(scale.rFrac * Math.max(w, h))))
    const outName = `gf_${scale.name}_out`
    const out = this.slot(outName, w, h, gl.RG16F)
    if (this.cacheKeys.get(outName) === key) return out
    const f32 = this.floatTargets ? gl.RG32F : gl.RG16F
    const m = this.slot(`gf_${scale.name}_m`, w, h, f32, { filter: 'nearest' })
    const t = this.slot(`gf_${scale.name}_t`, w, h, f32, { filter: 'nearest' })

    this.draw(this.p.gfPrep, m, w, h)
    bindTex(gl, this.p.gfPrep, 'uSrc', 0, work.tex)
    this.tri()
    this.box(m, t, [1, 0], r)
    this.box(t, m, [0, 1], r)
    this.draw(this.p.gfCoef, t, w, h)
    bindTex(gl, this.p.gfCoef, 'uMoments', 0, m.tex)
    setUniforms(gl, this.p.gfCoef, { uEps: scale.eps })
    this.tri()
    this.box(t, m, [1, 0], r)
    this.box(m, out, [0, 1], r)
    this.cacheKeys.set(outName, key)
    return out
  }

  private box(src: Tex, dst: Tex, dir: [number, number], r: number) {
    const p = this.p.box
    this.draw(p, dst, dst.width, dst.height)
    bindTex(this.gl, p, 'uSrc', 0, src.tex)
    setUniforms(this.gl, p, { uDir: dir, uRadius: { int: r } })
    this.tri()
  }

  private glow(work: Tex, spec: RenderSpec, key: string, headroom: boolean, space: SourceSpace): Tex {
    const gl = this.gl
    const fmt = this.workFormat
    const [w0, h0] = fitLongEdge(work.width, work.height, Math.min(GLOW_RES, Math.max(work.width, work.height)))
    const levels: Tex[] = []
    const accs: Tex[] = []
    for (let i = 0; i < GLOW_LEVELS; i++) {
      const w = Math.max(1, w0 >> i)
      const h = Math.max(1, h0 >> i)
      levels.push(this.slot(`glow_l${i}`, w, h, fmt))
      accs.push(this.slot(`glow_a${i}`, w, h, fmt))
    }
    // The output space sets where RAW light above white stops (clampWhite).
    const fullKey = key + space + JSON.stringify(spec.glow)
    if (this.cacheKeys.get('glow') === fullKey) return accs[0]

    this.draw(this.p.glowPrep, levels[0], w0, h0)
    bindTex(gl, this.p.glowPrep, 'uSrc', 0, work.tex)
    setUniforms(gl, this.p.glowPrep, {
      uHalThreshold: spec.glow.halThreshold,
      uBloomThreshold: spec.glow.bloomThreshold,
      uRawExposure: spec.glow.exposure,
      uClampWhite: headroom,
      uOutP3: space === 'display-p3',
      uSrgbToP3: SRGB_TO_P3,
      uP3ToSrgb: P3_TO_SRGB,
    })
    this.tri()
    for (let i = 1; i < GLOW_LEVELS; i++) {
      const src = levels[i - 1]
      this.draw(this.p.down, levels[i], levels[i].width, levels[i].height)
      bindTex(gl, this.p.down, 'uSrc', 0, src.tex)
      setUniforms(gl, this.p.down, { uTexel: [1 / src.width, 1 / src.height] })
      this.tri()
    }
    for (let i = GLOW_LEVELS - 1; i >= 0; i--) {
      const coarse = i === GLOW_LEVELS - 1 ? this.black : accs[i + 1]
      this.draw(this.p.up, accs[i], accs[i].width, accs[i].height)
      bindTex(gl, this.p.up, 'uSrc', 0, coarse.tex)
      bindTex(gl, this.p.up, 'uFine', 1, levels[i].tex)
      setUniforms(gl, this.p.up, { uTexel: [1 / coarse.width, 1 / coarse.height], uWeight: spec.glow.weights[i] })
      this.tri()
    }
    this.cacheKeys.set('glow', fullKey)
    return accs[0]
  }

  private develop(
    work: Tex,
    spec: RenderSpec,
    layers: { base: Tex; mid: Tex; fine: Tex; glow: Tex },
    target: Tex | null,
    w: number,
    h: number,
    tile: {
      offset: [number, number]
      imageSize: [number, number]
      pad: number
      fullLong: number
      levels?: number
      space?: SourceSpace
      clampWhite?: boolean
    },
  ) {
    const gl = this.gl
    const p = this.p.develop
    this.draw(p, target, w, h)
    bindTex(gl, p, 'uWork', 0, work.tex)
    bindTex(gl, p, 'uBaseCoef', 1, layers.base.tex)
    bindTex(gl, p, 'uMidCoef', 2, layers.mid.tex)
    bindTex(gl, p, 'uFineCoef', 3, layers.fine.tex)
    bindTex(gl, p, 'uGlow', 4, layers.glow.tex)
    bindTex(gl, p, 'uLut', 5, this.lut, gl.TEXTURE_3D)
    setUniforms(gl, p, {
      ...spec.develop,
      ...(this.halfTargets ? {} : { uLocalOn: 0 }),
      uOutSize: [w, h],
      uImageOffset: tile.offset,
      uImageSize: tile.imageSize,
      uGrainFull: tile.fullLong,
      uWorkPad: { ivec2: [tile.pad, tile.pad] },
      // An edit that changes no colors already lands on the source's own values; dither would move a quarter of them.
      uDither: spec.neutral ? 0 : 1 / (tile.levels ?? 255),
      uOutP3: tile.space === 'display-p3',
      uClampWhite: !!tile.clampWhite,
      uSrgbToP3: SRGB_TO_P3,
      uP3ToSrgb: P3_TO_SRGB,
    })
    this.tri()
  }

  // ---------------------------------------------------------------- public

  spec(edit: Edit) {
    return buildRenderSpec(edit, this.resolve)
  }

  /** Global low-res layers (guided filters, glow) from a mipmapped work texture. */
  private layers(work: Tex, spec: RenderSpec, key: string, headroom: boolean, space: SourceSpace) {
    const b = this.black
    // Without half-float render targets there is no guided filter: Highlights, Shadows, Clarity and Texture are off.
    const local = this.halfTargets
    return {
      base: local && spec.local.base ? this.guided(work, SCALES[0], key) : b,
      mid: local && spec.local.mid ? this.guided(work, SCALES[1], key) : b,
      fine: local && spec.local.fine ? this.guided(work, SCALES[2], key) : b,
      glow: spec.glow.on ? this.glow(work, spec, key, headroom, space) : b,
    }
  }

  /**
   * Render an edit at (W,H) onto the canvas and return it as an ImageBitmap.
   * Used for the main view and thumbnails.
   */
  renderBitmap(src: Source, edit: Edit, W: number, H: number, fullLong = 0, space: SourceSpace = 'srgb'): ImageBitmap {
    this.renderInto(src, edit, W, H, null, fullLong, space)
    return this.transfer()
  }

  /** The canvas's frame as a bitmap; a lost context has none to give. */
  private transfer() {
    this.live()
    return this.canvas.transferToImageBitmap()
  }

  private renderInto(
    src: Source,
    edit: Edit,
    W: number,
    H: number,
    target: Tex | null,
    fullLong = 0,
    space: SourceSpace = 'srgb',
  ) {
    this.use(src)
    const gl = this.gl
    if (!target && (this.canvas.width !== W || this.canvas.height !== H)) {
      this.canvas.width = W
      this.canvas.height = H
    }
    const spec = this.spec(edit)
    this.bakeLut(spec)
    const xform = outputToSource(edit.crop, src.width, src.height)
    const center = apply(xform, [0.5, 0.5, 1]).slice(0, 2) as [number, number]
    const geomKey = JSON.stringify([src.id, W, H, edit.crop, spec.aberration])
    const work = this.slot('work', W, H, this.workFormat, { mips: true })
    if (this.cacheKeys.get('work') !== geomKey) {
      this.geometry(src, xform, center, spec.aberration, work)
      this.cacheKeys.set('work', geomKey)
    }
    const layers = this.layers(work, spec, geomKey, src.headroom, space)
    if (!target) this.tagDrawingBuffer(space)
    this.develop(work, spec, layers, target, W, H, {
      offset: [0, 0],
      imageSize: [W, H],
      pad: 0,
      fullLong,
      space,
      clampWhite: src.headroom,
    })
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /**
   * Render a window of the full-size output at 1:1 (the 100% loupe). The
   * rect is in output pixels with a top-left origin. Global filter layers
   * come from a downscaled work image, exactly as in tiled export.
   */
  renderRegion(
    src: Source,
    edit: Edit,
    W: number,
    H: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    fullLong = 0,
    space: SourceSpace = 'srgb',
  ): ImageBitmap {
    this.regionInto(null, src, edit, W, H, rx, ry, rw, rh, fullLong, space)
    return this.transfer()
  }

  /** The 100% loupe region through the non-blocking readback (see readLater). Rows bottom-up. */
  regionLater(
    src: Source,
    edit: Edit,
    W: number,
    H: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    fullLong: number,
    space: SourceSpace,
  ) {
    return this.readLater(rw, rh, space, (target) =>
      this.regionInto(target, src, edit, W, H, rx, ry, rw, rh, fullLong, space),
    )
  }

  private regionInto(
    target: Tex | null,
    src: Source,
    edit: Edit,
    W: number,
    H: number,
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    fullLong: number,
    space: SourceSpace,
  ) {
    this.use(src)
    const gl = this.gl
    if (!target && (this.canvas.width !== rw || this.canvas.height !== rh)) {
      this.canvas.width = rw
      this.canvas.height = rh
    }
    const spec = this.spec(edit)
    this.bakeLut(spec)
    const xform = outputToSource(edit.crop, src.width, src.height)
    const center = apply(xform, [0.5, 0.5, 1]).slice(0, 2) as [number, number]
    const globalKey = JSON.stringify(['region', src.id, W, H, edit.crop, spec.aberration])
    const [gw, gh] = fitLongEdge(W, H, Math.min(SINGLE_PASS_MAX, Math.max(W, H)))
    const gwork = this.slot('region_global', gw, gh, this.workFormat, { mips: true })
    if (this.cacheKeys.get('region_global') !== globalKey) {
      this.geometry(src, xform, center, spec.aberration, gwork)
      this.cacheKeys.set('region_global', globalKey)
    }
    const layers = this.layers(gwork, spec, globalKey, src.headroom, space)
    const ox = rx
    const oy = H - (ry + rh) // GL origin is bottom-left
    const pw = rw + TILE_PAD * 2
    const ph = rh + TILE_PAD * 2
    const twork = this.slot('region_tile', pw, ph, this.workFormat)
    this.geometry(
      src,
      mul(xform, tileMatrix(ox - TILE_PAD, oy - TILE_PAD, pw, ph, W, H)),
      center,
      spec.aberration,
      twork,
    )
    if (!target) this.tagDrawingBuffer(space)
    this.develop(twork, spec, layers, target, rw, rh, {
      offset: [ox, oy],
      imageSize: [W, H],
      pad: TILE_PAD,
      fullLong,
      space,
      clampWhite: src.headroom,
    })
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  /** Free loupe buffers when leaving 100% view. */
  releaseRegion() {
    for (const k of ['region_global', 'region_tile']) {
      deleteTex(this.gl, this.slots.get(k))
      this.slots.delete(k)
      this.cacheKeys.delete(k)
    }
  }

  /**
   * Full-resolution render to RGBA8 pixels (top row first), in tiles of at most
   * 2048 px so memory stays bounded. The global layers come from one work image
   * of at most SINGLE_PASS_MAX on the long edge.
   */
  async renderPixels(
    src: Source,
    edit: Edit,
    W: number,
    H: number,
    onProgress?: (f: number) => void,
    fullLong = 0,
    space: SourceSpace = 'srgb',
  ) {
    const out = new Uint8ClampedArray(W * H * 4)
    const gl = this.gl
    await this.renderTiles(src, edit, W, H, onProgress, fullLong, 8, space, (ox, imgY0, tw, th) => {
      const buf = new Uint8Array(tw * th * 4)
      gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      // GL rows are bottom-up; image rows top-down.
      for (let y = 0; y < th; y++) out.set(buf.subarray(y * tw * 4, (y + 1) * tw * 4), ((imgY0 - y) * W + ox) * 4)
    })
    return out
  }

  /**
   * Full-resolution render to 16-bit RGB (top row first) for 16-bit exports: float tiles end to end and a dither of
   * one 16-bit level. Needs float render targets.
   */
  async renderPixels16(
    src: Source,
    edit: Edit,
    W: number,
    H: number,
    onProgress?: (f: number) => void,
    fullLong = 0,
    space: SourceSpace = 'srgb',
  ) {
    if (!this.floatTargets) throw new Error('16-bit export needs float render targets (EXT_color_buffer_float)')
    const out = new Uint16Array(W * H * 3)
    const gl = this.gl
    await this.renderTiles(src, edit, W, H, onProgress, fullLong, 16, space, (ox, imgY0, tw, th) => {
      const buf = new Float32Array(tw * th * 4)
      gl.readPixels(0, 0, tw, th, gl.RGBA, gl.FLOAT, buf)
      for (let y = 0; y < th; y++) {
        let o = ((imgY0 - y) * W + ox) * 3
        for (let i = y * tw * 4, end = i + tw * 4; i < end; i += 4) {
          out[o++] = Math.round(Math.min(1, Math.max(0, buf[i])) * 65535)
          out[o++] = Math.round(Math.min(1, Math.max(0, buf[i + 1])) * 65535)
          out[o++] = Math.round(Math.min(1, Math.max(0, buf[i + 2])) * 65535)
        }
      }
    })
    return out
  }

  /** Render the output in tiles, handing each tile's framebuffer to `read` while it is bound. */
  private async renderTiles(
    src: Source,
    edit: Edit,
    W: number,
    H: number,
    onProgress: ((f: number) => void) | undefined,
    fullLong: number,
    depth: 8 | 16,
    space: SourceSpace,
    read: (ox: number, imgY0: number, tw: number, th: number) => void,
  ) {
    // One export at a time: they share the export_* buffers.
    const prev = this.exportLock
    let release = () => {}
    this.exportLock = new Promise<void>((r) => (release = r))
    await prev
    try {
      await this.renderTilesNow(src, edit, W, H, onProgress, fullLong, depth, space, read)
    } finally {
      release()
    }
  }

  private async renderTilesNow(
    src: Source,
    edit: Edit,
    W: number,
    H: number,
    onProgress: ((f: number) => void) | undefined,
    fullLong: number,
    depth: 8 | 16,
    space: SourceSpace,
    read: (ox: number, imgY0: number, tw: number, th: number) => void,
  ) {
    this.use(src)
    const gl = this.gl
    const spec = this.spec(edit)
    this.bakeLut(spec)
    const xform = outputToSource(edit.crop, src.width, src.height)
    const center = apply(xform, [0.5, 0.5, 1]).slice(0, 2) as [number, number]

    try {
      // Global layers come from a downscaled work image; tiles sample them in image space.
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
      const [gw, gh] = fitLongEdge(W, H, Math.min(SINGLE_PASS_MAX, max, Math.max(W, H)))
      const gwork = this.slot('export_global', gw, gh, this.workFormat, { mips: true })
      this.geometry(src, xform, center, spec.aberration, gwork)
      const exportKey = 'export:' + Math.random()
      let layers = this.layers(gwork, spec, exportKey, src.headroom, space)

      // A requested small export fits the proxy's detail already. Avoid enormous original regions for tiny outputs.
      const [cropW, cropH] = cropPixelSize(edit.crop, src.width, src.height)
      const needOriginal =
        src.original &&
        Math.max(W / cropW, H / cropH) * Math.max(src.width / src.tex.width, src.height / src.tex.height) > 1
      const tiles = exportTiles(
        W,
        H,
        max,
        TILE_PAD,
        needOriginal ? { width: src.width, height: src.height, xform, center, aberration: spec.aberration } : undefined,
      )
      let done = 0
      for (const tile of tiles) {
        // The context may have gone while the event loop ran: stop rather than export blank tiles.
        this.live()
        const { x: ox, y: oy, width: tw, height: th } = tile
        const pw = tw + TILE_PAD * 2
        const ph = th + TILE_PAD * 2
        // The event loop ran since the last tile: a preview or thumbnail render may have rebaked the LUT or reused the
        // guided-filter and glow buffers. Take them back; both are no-ops when nothing else rendered.
        this.bakeLut(spec)
        layers = this.layers(gwork, spec, exportKey, src.headroom, space)
        // 16-bit: the tile's linear working copy and its output in 32-bit floats, so nothing rounds at 11 bits.
        const twork = this.slot('export_tile', pw, ph, depth === 16 ? gl.RGBA32F : this.workFormat)
        const tm = tileMatrix(ox - TILE_PAD, oy - TILE_PAD, pw, ph, W, H)
        const m = mul(xform, tm)
        const region = tile.source ? this.sourceRegion(src, tile.source) : null
        try {
          this.geometry(region ?? src, m, center, spec.aberration, twork)
        } finally {
          if (region) this.deleteSource(region)
        }
        const outTex = this.slot('export_out', tw, th, depth === 16 ? gl.RGBA32F : gl.RGBA8, { filter: 'nearest' })
        this.develop(twork, spec, layers, outTex, tw, th, {
          offset: [ox, oy],
          imageSize: [W, H],
          pad: TILE_PAD,
          fullLong,
          levels: depth === 16 ? 65535 : 255,
          space,
          clampWhite: src.headroom,
        })
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboFor(gl, outTex))
        read(ox, H - 1 - oy, tw, th)
        // A context lost during the read hands back zeros.
        this.live()
        done += tw * th
        onProgress?.(done / (W * H))
        await new Promise((r) => setTimeout(r, 0))
      }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      // Drop export-sized buffers so they do not linger in GPU memory.
      for (const k of ['export_global', 'export_tile', 'export_out']) {
        deleteTex(gl, this.slots.get(k))
        this.slots.delete(k)
      }
      this.cacheKeys.delete('glow')
    }
  }

  private viewPbos: { buf: WebGLBuffer; bytes: number; done: Promise<void> | null }[] = []

  /**
   * renderInto for display through the CPU, for browsers whose WebGL bitmaps lose their color space (WebKit drops
   * Display P3): into a framebuffer, then into a pixel buffer behind a fence, handed over once the GPU is done so
   * the main thread never waits on it (Safari 27.2 beta: about 2.6 ms of copying and drawing a 2560 px frame, against
   * 10 to 14 ms of a blocking readPixels). Two pixel buffers alternate, so the next frame renders while the last
   * one is still on its way back. Rows come bottom-up, GL's order.
   */
  renderLater(src: Source, edit: Edit, W: number, H: number, fullLong: number, space: SourceSpace): Promise<ImageData> {
    return this.readLater(W, H, space, (target) => this.renderInto(src, edit, W, H, target, fullLong, space))
  }

  private async readLater(W: number, H: number, space: SourceSpace, draw: (target: Tex) => void): Promise<ImageData> {
    const gl = this.gl
    const bytes = W * H * 4
    this.live()
    let slot = this.viewPbos.find((p) => !p.done)
    if (!slot && this.viewPbos.length < 2) {
      slot = { buf: gl.createBuffer(), bytes: 0, done: null }
      this.viewPbos.push(slot)
    }
    while (!slot) {
      await Promise.race(this.viewPbos.flatMap((p) => (p.done ? [p.done] : [])))
      // The reads ahead may have ended with the context.
      this.live()
      slot = this.viewPbos.find((p) => !p.done)
    }
    let finish = () => {}
    slot.done = new Promise<void>((r) => (finish = r))
    let fence: WebGLSync | null = null
    try {
      const target = this.slot('view_out', W, H, gl.RGBA8, { filter: 'nearest' })
      draw(target)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf)
      if (slot.bytes !== bytes) {
        gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ)
        slot.bytes = bytes
      }
      // GL runs commands in order, so the next frame may reuse view_out once this read is queued.
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboFor(gl, target))
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, 0)
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
      if (!fence) {
        this.live()
        throw new Error('fenceSync failed')
      }
      gl.flush()
      // A lost context never signals the fence (its status reads null): stop waiting once the context is gone.
      while (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
        this.live()
        await new Promise((r) => setTimeout(r, 1))
      }
      const px = new Uint8ClampedArray(bytes)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.buf)
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, px)
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null)
      // A context lost during the copy hands back zeros.
      this.live()
      return new ImageData(px, W, H, { colorSpace: space })
    } finally {
      if (fence && !gl.isContextLost()) gl.deleteSync(fence)
      slot.done = null
      finish()
    }
  }

  /** Read the baked LUT back (for .cube export). RGB floats, r fastest. */
  readLut(edit: Edit): Float32Array {
    this.live()
    const gl = this.gl
    this.bakeLut(this.spec(edit))
    const N = LUT_SIZE
    const out = new Float32Array(N * N * N * 3)
    // Read in the LUT's own format: floats, or bytes for the RGBA8 LUT without float render targets.
    const buf = this.floatTargets ? new Float32Array(N * N * 4) : new Uint8Array(N * N * 4)
    const scale = this.floatTargets ? 1 : 1 / 255
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lutFbo)
    for (let z = 0; z < N; z++) {
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, this.lut, 0, z)
      gl.readPixels(0, 0, N, N, gl.RGBA, this.floatTargets ? gl.FLOAT : gl.UNSIGNED_BYTE, buf)
      for (let i = 0; i < N * N; i++) for (let c = 0; c < 3; c++) out[(z * N * N + i) * 3 + c] = buf[i * 4 + c] * scale
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    // A context lost during the reads hands back zeros.
    this.live()
    return out
  }

  invalidateLut() {
    this.lutKey = ''
    this.termSlots = this.termSlots.map(() => null)
  }
}
