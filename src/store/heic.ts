import type { HeicReply, HeicRequest } from './heic.worker'

// One worker for every HEIC decode, started with the first one.
let worker: Worker | null = null
let next = 0
const waiting = new Map<number, { resolve: (b: ImageBitmap) => void; reject: (e: Error) => void }>()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./heic.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = ({ data }: MessageEvent<HeicReply>) => {
    const w = waiting.get(data.id)
    waiting.delete(data.id)
    if (data.bitmap) w?.resolve(data.bitmap)
    else w?.reject(new Error(data.error ?? 'HEIC decoding failed'))
  }
  worker.onerror = (e) => {
    for (const w of waiting.values()) w.reject(new Error(e.message || 'HEIC decoder failed to load'))
    waiting.clear()
    worker = null
  }
  return worker
}

/** Decodes a HEIC file to an sRGB bitmap with the bundled decoder. */
export async function decodeHeic(blob: Blob): Promise<ImageBitmap> {
  const bytes = await blob.arrayBuffer()
  return new Promise((resolve, reject) => {
    const id = ++next
    waiting.set(id, { resolve, reject })
    getWorker().postMessage({ id, bytes } satisfies HeicRequest, [bytes])
  })
}
