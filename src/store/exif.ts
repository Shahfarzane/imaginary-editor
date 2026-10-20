import { photoInfo, type ExifTags, type PhotoInfo } from '../model/photoInfo'
import { rawInfo } from './rawInfo'

/** Camera, lens and exposure from a photo's metadata. The reader loads with the first photo it reads. */
export async function readInfo(blob: Blob, name: string): Promise<PhotoInfo> {
  const { default: ExifReader } = await import('exifreader')
  let tags: ExifTags = {}
  try {
    tags = ExifReader.load(await blob.arrayBuffer()) as unknown as ExifTags
  } catch {
    // No metadata the reader understands (a screenshot, a PNG from an editor): the file facts still show.
  }
  const info = photoInfo(tags, blob.size, name, blob.type)
  // A RAW file ExifReader could not read: what LibRaw found while decoding it.
  const fromRaw = rawInfo.get(blob)
  if (fromRaw && !info.make && !info.model) Object.assign(info, Object.fromEntries(Object.entries(fromRaw).filter(([, v]) => v !== undefined)))
  return info
}
