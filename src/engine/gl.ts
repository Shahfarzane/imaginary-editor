import commonGlsl from './shaders/common.glsl?raw'

export type GL = WebGL2RenderingContext

export interface Program {
  prog: WebGLProgram
  uniforms: Map<string, WebGLUniformLocation | null>
}

export function compileProgram(gl: GL, vert: string, frag: string, name: string): Program {
  const header = '#version 300 es\nprecision highp float;\nprecision highp int;\n'
  const vs = compileShader(gl, gl.VERTEX_SHADER, header + vert, name + '.vert')
  const fs = compileShader(
    gl,
    gl.FRAGMENT_SHADER,
    header + 'precision highp sampler2D;\nprecision highp sampler3D;\n' + commonGlsl + '\n' + frag,
    name + '.frag',
  )
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(`link ${name}: ${gl.getProgramInfoLog(prog)}`)
  }
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  return { prog, uniforms: new Map() }
}

function compileShader(gl: GL, type: number, src: string, name: string) {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? ''
    // Point at the offending line to make shader errors readable.
    const m = /ERROR: \d+:(\d+)/.exec(log)
    const line = m ? src.split('\n')[Number(m[1]) - 1] : ''
    throw new Error(`compile ${name}: ${log}\n> ${line}`)
  }
  return sh
}

export function loc(gl: GL, p: Program, name: string) {
  let l = p.uniforms.get(name)
  if (l === undefined) {
    l = gl.getUniformLocation(p.prog, name)
    p.uniforms.set(name, l)
  }
  return l
}

export type UniformValue = number | boolean | number[] | Float32Array | Int32Array | { int: number } | { ivec2: [number, number] }

/** Set uniforms by name. Arrays of length 9 are mat3 (row-major in, column-major out). */
export function setUniforms(gl: GL, p: Program, u: Record<string, UniformValue>) {
  for (const [name, v] of Object.entries(u)) {
    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Float32Array) && !(v instanceof Int32Array)) {
      if ('int' in v) gl.uniform1i(loc(gl, p, name), v.int)
      else gl.uniform2i(loc(gl, p, name), v.ivec2[0], v.ivec2[1])
      continue
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
      gl.uniform1f(loc(gl, p, name), Number(v))
      continue
    }
    const arr = v as number[] | Float32Array
    if (name.endsWith('[]')) {
      gl.uniform1fv(loc(gl, p, name.slice(0, -2) + '[0]'), arr)
      continue
    }
    const l = loc(gl, p, name)
    switch (arr.length) {
      case 2:
        gl.uniform2fv(l, arr)
        break
      case 3:
        gl.uniform3fv(l, arr)
        break
      case 4:
        gl.uniform4fv(l, arr)
        break
      case 9:
        gl.uniformMatrix3fv(l, true, arr)
        break
      default:
        gl.uniform1fv(l, arr)
    }
  }
}

export interface Tex {
  tex: WebGLTexture
  width: number
  height: number
  internal: number
  mips: boolean
}

export function createTex(
  gl: GL,
  width: number,
  height: number,
  internal: number,
  opts: { filter?: 'linear' | 'nearest'; mips?: boolean; data?: ArrayBufferView | null; format?: number; type?: number } = {},
): Tex {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const { format, type } = formatFor(gl, internal, opts)
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, opts.data ?? null)
  const lin = (opts.filter ?? 'linear') === 'linear'
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, opts.mips ? gl.LINEAR_MIPMAP_LINEAR : lin ? gl.LINEAR : gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, lin ? gl.LINEAR : gl.NEAREST)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return { tex, width, height, internal, mips: !!opts.mips }
}

function formatFor(gl: GL, internal: number, opts: { format?: number; type?: number }) {
  if (opts.format && opts.type) return { format: opts.format, type: opts.type }
  switch (internal) {
    case gl.RGBA16F:
      return { format: gl.RGBA, type: gl.HALF_FLOAT }
    case gl.RG16F:
      return { format: gl.RG, type: gl.HALF_FLOAT }
    case gl.RG32F:
      return { format: gl.RG, type: gl.FLOAT }
    case gl.R32F:
      return { format: gl.RED, type: gl.FLOAT }
    case gl.RGBA32F:
      return { format: gl.RGBA, type: gl.FLOAT }
    default:
      return { format: gl.RGBA, type: gl.UNSIGNED_BYTE }
  }
}

/** Framebuffers are cached per texture. */
const fbos = new WeakMap<WebGLTexture, WebGLFramebuffer>()
export function fboFor(gl: GL, t: Tex) {
  let f = fbos.get(t.tex)
  if (!f) {
    f = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, f)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0)
    fbos.set(t.tex, f)
  }
  return f
}

export function deleteTex(gl: GL, t: Tex | null | undefined) {
  if (!t) return
  const f = fbos.get(t.tex)
  if (f) gl.deleteFramebuffer(f)
  gl.deleteTexture(t.tex)
}

export function bindTex(gl: GL, p: Program, name: string, unit: number, tex: WebGLTexture | null, target: number = gl.TEXTURE_2D) {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(target, tex)
  gl.uniform1i(loc(gl, p, name), unit)
}
