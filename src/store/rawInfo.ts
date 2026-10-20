import type { PhotoInfo } from '../model/photoInfo'

/** Camera facts LibRaw read while decoding a RAW file, for formats ExifReader cannot read (Canon CR3, among others). */
export const rawInfo = new WeakMap<Blob, Partial<PhotoInfo>>()
