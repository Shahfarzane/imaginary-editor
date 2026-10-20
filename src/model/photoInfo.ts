// What the info panel shows about a photo, read once from its EXIF (camera, lens, exposure, when it was taken).

export interface PhotoInfo {
  make?: string
  model?: string
  lens?: string
  /** Millimetres. */
  focalLength?: number
  fNumber?: number
  /** Seconds. */
  exposureTime?: number
  iso?: number
  /** When it was taken, as written in the file: local time, with its UTC offset when the camera recorded one. */
  taken?: string
  /** Bytes of the original file. */
  fileSize: number
  /** File type from the name or the MIME type (JPEG, HEIC, PNG, DNG...). */
  format: string
}

type Tag = { value: unknown; description?: unknown }
export type ExifTags = Record<string, Tag | undefined>

const text = (t: Tag | undefined) => {
  const v = Array.isArray(t?.value) ? t.value[0] : t?.value
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}
const num = (t: Tag | undefined) => {
  const v = t?.value
  if (typeof v === 'number') return v
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number' && v[1]) return v[0] / v[1]
  if (Array.isArray(v) && typeof v[0] === 'number') return v[0]
  return undefined
}

/** The info panel's fields from ExifReader's tags (flat form). */
export function photoInfo(tags: ExifTags, fileSize: number, name: string, type: string): PhotoInfo {
  const date = text(tags.DateTimeOriginal) ?? text(tags.DateTime)
  const offset = text(tags.OffsetTimeOriginal)
  const model = text(tags.Model)
  const make = text(tags.Make)
  return {
    make,
    // Many cameras repeat the make in the model ("Canon Canon EOS R5"): keep it once.
    model: make && model?.toLowerCase().startsWith(make.toLowerCase()) ? model.slice(make.length).trim() || model : model,
    lens: text(tags.LensModel),
    focalLength: num(tags.FocalLength),
    fNumber: num(tags.FNumber),
    exposureTime: num(tags.ExposureTime),
    iso: num(tags.ISOSpeedRatings) ?? num(tags.PhotographicSensitivity),
    taken: date && `${date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')}${offset ?? ''}`,
    fileSize,
    format: (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? type.split('/')[1] ?? '').toUpperCase().replace('JPG', 'JPEG'),
  }
}

export const shutter = (s: number) => (s >= 1 ? `${+s.toFixed(1)} s` : `1/${Math.round(1 / s)} s`)
