import { describe, expect, it } from 'vite-plus/test'
import { defaultEdit } from './edit'
import { filterActive, matchesFilter, NO_FILTER } from './filter'
import { photoInfo, shutter } from './photoInfo'
import { presetEdit } from '../store/userPresets'

describe('library filter', () => {
  const plain = defaultEdit(1)
  const edited = { ...defaultEdit(1), preset: { ...defaultEdit(1).preset, id: 'pr1', tile: 'KI1' } }
  const code = (e: typeof plain) => e.preset.tile ?? null
  it('shows everything without a filter', () => {
    expect(filterActive(NO_FILTER)).toBe(false)
    expect(matchesFilter({ edit: plain }, NO_FILTER, code)).toBe(true)
  })
  it('filters by favorite, edited and preset together', () => {
    const f = { ...NO_FILTER, favorites: true }
    expect(filterActive(f)).toBe(true)
    expect(matchesFilter({ favorite: true, edit: plain }, f, code)).toBe(true)
    expect(matchesFilter({ edit: plain }, f, code)).toBe(false)
    expect(matchesFilter({ edit: edited }, { ...NO_FILTER, edited: 'edited' }, code)).toBe(true)
    expect(matchesFilter({ edit: plain }, { ...NO_FILTER, edited: 'edited' }, code)).toBe(false)
    expect(matchesFilter({ edit: plain }, { ...NO_FILTER, edited: 'unedited' }, code)).toBe(true)
    expect(matchesFilter({ edit: edited }, { ...NO_FILTER, preset: 'KI1' }, code)).toBe(true)
    expect(matchesFilter({ edit: edited }, { ...NO_FILTER, preset: 'KI2' }, code)).toBe(false)
  })
})

describe('photo info', () => {
  it('reads camera, lens and exposure from EXIF tags', () => {
    const info = photoInfo(
      {
        Make: { value: ['Canon'] },
        Model: { value: ['Canon EOS R5'] },
        LensModel: { value: ['RF24-70mm F2.8 L IS USM'] },
        FocalLength: { value: [35, 1] },
        FNumber: { value: [28, 10] },
        ExposureTime: { value: [1, 250] },
        ISOSpeedRatings: { value: 400 },
        DateTimeOriginal: { value: ['2026:09:11 09:28:53'] },
        OffsetTimeOriginal: { value: ['+02:00'] },
      },
      12_000_000,
      'IMG_1.CR3',
      '',
    )
    expect(info).toMatchObject({ make: 'Canon', model: 'EOS R5', lens: 'RF24-70mm F2.8 L IS USM', focalLength: 35, fNumber: 2.8, iso: 400 })
    expect(info.exposureTime).toBeCloseTo(1 / 250)
    expect(info.taken).toBe('2026-09-11 09:28:53+02:00')
    expect(info.format).toBe('CR3')
    expect(shutter(1 / 250)).toBe('1/250 s')
    expect(shutter(2)).toBe('2 s')
  })
  it('keeps the file facts when there is no metadata', () => {
    expect(photoInfo({}, 1000, 'shot.jpg', 'image/jpeg')).toEqual({
      make: undefined, model: undefined, lens: undefined, focalLength: undefined, fNumber: undefined,
      exposureTime: undefined, iso: undefined, taken: undefined, fileSize: 1000, format: 'JPEG',
    })
  })
})

describe('your presets', () => {
  it('keep every look and tool setting but not the framing or the grain seed', () => {
    const e = defaultEdit(42)
    e.preset = { ...e.preset, id: 'pr1', strength: 0.7 }
    e.tools.exposure = 0.3
    e.crop = { ...e.crop, x: 0.1, w: 0.8, rot90: 1 }
    const p = presetEdit(e)
    expect(p.preset).toMatchObject({ id: 'pr1', strength: 0.7 })
    expect(p.tools.exposure).toBe(0.3)
    expect(p.crop).toEqual(defaultEdit(0).crop)
    expect(p.seed).toBe(defaultEdit(0).seed)
    expect(e.crop.w).toBe(0.8)
  })
})

