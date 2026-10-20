// One rendered frame for an on-screen view, in the display's color space (store/render.ts viewRoute): a bitmap where
// WebGL bitmaps keep their color space, or Display P3 pixels read back off the GPU without blocking and drawn
// upright into a P3 canvas where they do not (Safari).
import { viewRoute } from '../store/render'
import type { SourceSpace } from '../engine/renderer'

export type ViewFrame = ImageBitmap | OffscreenCanvas

/**
 * `bitmap` renders on the GPU and hands back a bitmap; `later` renders the same frame through the readback, rows
 * bottom-up. Which one runs is fixed for the session.
 */
export async function viewFrame(bitmap: (space: SourceSpace) => ImageBitmap, later: (space: SourceSpace) => Promise<ImageData>): Promise<ViewFrame> {
  const { space, readback } = viewRoute()
  if (!readback) return bitmap(space)
  const img = await later(space)
  const flipped = new OffscreenCanvas(img.width, img.height)
  flipped.getContext('2d', { colorSpace: space })!.putImageData(img, 0, 0)
  const upright = new OffscreenCanvas(img.width, img.height)
  const g = upright.getContext('2d', { colorSpace: space })!
  g.setTransform(1, 0, 0, -1, 0, img.height)
  g.drawImage(flipped, 0, 0)
  return upright
}

/** Put a frame on a view's canvas (the canvas keeps one kind of context for the session). */
export function showFrame(canvas: HTMLCanvasElement, frame: ViewFrame) {
  canvas.width = frame.width
  canvas.height = frame.height
  const { readback, space } = viewRoute()
  if (readback) canvas.getContext('2d', { colorSpace: space })!.drawImage(frame, 0, 0)
  else canvas.getContext('bitmaprenderer')!.transferFromImageBitmap(frame instanceof ImageBitmap ? frame : frame.transferToImageBitmap())
}

/** The color space view frames are in, for composing borders around them. */
export const frameSpace = () => viewRoute().space
