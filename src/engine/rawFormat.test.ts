import { describe, expect, it } from 'vite-plus/test'
import { isRawCandidate } from './rawFormat'
import { fromBt709 } from '../store/raw'

const bytes = (s: string, pad = 32) => {
  const b = new Uint8Array(Math.max(pad, s.length))
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
  return b
}

describe('RAW files', () => {
  it('knows the TIFF family, Canon CR3 and Fujifilm RAF by their first bytes', () => {
    expect(isRawCandidate(bytes('II*\0'))).toBe(true)
    expect(isRawCandidate(bytes('MM\0*'))).toBe(true)
    expect(isRawCandidate(bytes('IIRO'))).toBe(true)
    expect(isRawCandidate(bytes('IIU\0'))).toBe(true)
    expect(isRawCandidate(bytes('\0\0\0\x18ftypcrx '))).toBe(true)
    expect(isRawCandidate(bytes('FUJIFILMCCD-RAW 0201'))).toBe(true)
    expect(isRawCandidate(bytes('\xff\xd8\xff\xe1'))).toBe(false)
    expect(isRawCandidate(bytes('\0\0\0\x18ftypheic'))).toBe(false)
  })
  it('undoes the BT.709 curve LibRaw encodes with', () => {
    const encode = (l: number) => (l < 0.018 ? 4.5 * l : 1.099 * l ** 0.45 - 0.099)
    for (const l of [0, 0.001, 0.0212, 0.18, 0.5, 1]) expect(fromBt709(encode(l))).toBeCloseTo(l, 4)
  })
})
