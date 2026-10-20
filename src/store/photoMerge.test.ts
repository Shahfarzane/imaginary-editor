import { expect, test } from 'vite-plus/test'
import { defaultEdit } from '../model/edit'
import { mergePhoto, photoPatch } from './photoMerge'
import type { PhotoRecord } from './db'

const original = (): PhotoRecord => ({
  id: 'one',
  name: 'one.jpg',
  width: 1,
  height: 1,
  added: 0,
  order: 0,
  edit: defaultEdit(1),
})
test('independent tools merge and replay order cannot resurrect an older value', () => {
  const p = original(),
    a = structuredClone(p),
    b = structuredClone(p),
    c = structuredClone(p)
  a.edit.tools.exposure = 0.2
  b.favorite = true
  b.edit.tools.contrast = 0.3
  c.edit.tools.exposure = 0.7
  const pa = photoPatch(p, a, '1:a'),
    pb = photoPatch(p, b, '2:b'),
    pc = photoPatch(p, c, '3:a')
  const merged = mergePhoto(mergePhoto(mergePhoto(p, pc), pb), pa)
  expect(merged.edit.tools.exposure).toBe(0.7)
  expect(merged.edit.tools.contrast).toBe(0.3)
  expect(merged.favorite).toBe(true)
  expect(mergePhoto(merged, pb)).toEqual(merged)
})
test('crop and preset are atomic and tied operations converge', () => {
  const p = original(),
    a = structuredClone(p),
    b = structuredClone(p)
  a.edit.crop.w = 0.5
  a.edit.preset.id = 'cn6'
  b.edit.crop.rot90 = 1
  b.edit.preset.strength = 0.4
  const pa = photoPatch(p, a, '1:a'),
    pb = photoPatch(p, b, '1:b')
  const merged = mergePhoto(mergePhoto(p, pa), pb)
  expect(merged.edit.crop).toEqual(b.edit.crop)
  expect(merged.edit.preset).toEqual(b.edit.preset)
  expect(mergePhoto(mergePhoto(p, pb), pa)).toEqual(merged)
})
test('a legacy journal cannot overwrite a field already edited by this version', () => {
  const p = original(),
    a = structuredClone(p)
  a.edit.tools.exposure = 0.8
  const modern = mergePhoto(p, photoPatch(p, a, '1720000000000000:a'))
  expect(mergePhoto(modern, photoPatch(undefined, p, '0000000000000000:legacy')).edit.tools.exposure).toBe(0.8)
})
