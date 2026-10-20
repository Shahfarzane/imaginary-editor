// Decodes HEIC off the main thread with libheif (WebAssembly), for browsers without a HEIC decoder of
// their own. The ~2 MB decoder loads with the first HEIC file; a 24 MP photo takes one to two seconds.
import factory from 'libheif-js/libheif-wasm/libheif-bundle.mjs'
import { heifColors } from '../engine/heif'

export type HeicRequest = { id: number; bytes: ArrayBuffer }
export type HeicReply = { id: number; bitmap?: ImageBitmap; error?: string }

let lib: ReturnType<typeof factory> | null = null

self.onmessage = async ({ data: { id, bytes } }: MessageEvent<HeicRequest>) => {
  const reply = (r: Omit<HeicReply, 'id'>, transfer: Transferable[] = []) => self.postMessage({ id, ...r }, { transfer })
  try {
    lib ??= factory()
    const images = new lib.HeifDecoder().decode(new Uint8Array(bytes))
    try {
      const image = images.find((im) => im.is_primary()) ?? images[0]
      if (!image) throw new Error('no image in this HEIC file')
      const width = image.get_width()
      const height = image.get_height()
      const pixels = new Uint8ClampedArray(width * height * 4)
      await new Promise<void>((resolve, reject) =>
        image.display({ data: pixels, width, height }, (out) => (out ? resolve() : reject(new Error('HEIC decoding failed')))),
      )
      // iPhone photos are Display P3; the canvas converts them to sRGB like the browser's own decoders do.
      const canvas = new OffscreenCanvas(width, height)
      canvas.getContext('2d')!.putImageData(new ImageData(pixels, width, height, { colorSpace: heifColors(new Uint8Array(bytes)) }), 0, 0)
      const bitmap = canvas.transferToImageBitmap()
      reply({ bitmap }, [bitmap])
    } finally {
      for (const im of images) im.free()
    }
  } catch (e) {
    reply({ error: (e as Error).message })
  }
}
