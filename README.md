# Imaginary

A photo editor that runs in the browser: a parametric look engine, local tone tools, grain, halation and full-resolution export, on a WebGL2 color engine. Everything runs client-side. Photos stay in the browser's IndexedDB and never leave the machine.

This repository is the editor's code with four looks, the Lab looks made for it. The live studio at https://studio.imaginary.site has more looks; they are not part of this repository.

## Run

```sh
bun install
bun run dev      # http://localhost:5199
bun run test     # unit tests: color math, looks, tools, crop, HEIF sniffing
bun run e2e      # Playwright smoke tests in Chromium and WebKit (own dev server on 5399)
bun run check    # lint with type-aware checks
bun run build    # typecheck and production bundle in .cloudflare/output/
bun run deploy   # build, then upload to Cloudflare
```

The toolchain is [Vite+](https://viteplus.dev): `vp dev`, `vp test`, `vp check` and `vp build` sit behind the scripts. `bun run deploy` uploads the build with Cloudflare's [`cf` CLI](https://github.com/cloudflare/cf) as a Worker that only serves static assets (`cloudflare.config.ts`); sign in once with `bunx cf auth login`. The first `bun run e2e` needs `bunx playwright install chromium webkit`. `/?bench` times the engine in any browser on a synthetic 24 MP photo without touching the library.

## Browser support

The engine needs WebGL2 with `EXT_color_buffer_float` (current Chrome, Safari, Firefox). Without it the renderer falls back to 8-bit buffers. With half-float render targets (`EXT_color_buffer_half_float`) every tool still works. Without those, Highlights, Shadows, Clarity and Texture are off (the Tools panel says so) and 16-bit export is not offered. An e2e test covers both reduced paths.

## What it does

- Library: drag, paste or pick images. A justified grid (each photo at its own aspect ratio) with a size slider down to a single view, multi-select with a toolbar (copy and paste edits, reset to original, isolate or hold to compare, delete), a Filter menu in the rail (favorites, edited or not, preset), undo and redo, a before/after split (`B`), and `\` held for the original. The single view zooms from Fit to 1500% on the full-resolution original.
- Presets: the four Lab looks, Infrared, Duotone, Cyanotype and Shift. The engine also takes film families with Character (push and pull) and Warmth (scanner balance), and Contrast, Color and Tone for the others, either from hand-built slider models or from slider tables (none here). Presets sit in a strip of live previews under the photo or the grid (`P` shows or hides it), your own saved presets and collections first; a click applies one to every selected photo. In the single view ← and → step through the presets (↑ and ↓ through the photos). A right-click on a preset adds it to a collection of your own or starts one (⌘- or Shift-click picks several first), and dragging a preset or a group's label rearranges the strip; collections and the order are kept in the browser. Strength and the sliders sit on the photo in the single view and above the strip in the grid.
- Tools: exposure, RAW exposure, contrast, highlights, shadows, whites, blacks, fade, temperature, tint, saturation, vibrance, skin tone, clarity, texture, sharpen, 8-band selective color, split tone, RGB and per-channel curves, and a live histogram. Every tool runs on its built-in formula. RAW Exposure adds stops of light ahead of the tone tools and the white clamp, so a RAW photo's light above white can come back.
- Effects: grain (size, roughness, color), halation, bloom, vignette, chromatic aberration, light leaks, dust, and borders (solid, instant, 35mm, 120).
- Crop: aspect presets or a custom ratio, 90° rotation, flips, and straighten ±15° with auto-fit.
- Export: full-resolution JPEG, PNG or WebP, 16-bit PNG and 16-bit TIFF with an embedded ICC profile, in sRGB or Display P3; batch zip; contact sheet; and the current look as a 33³ `.cube` for Resolve, Premiere or Final Cut. A 16-bit export renders in 32-bit float tiles and dithers by one 16-bit level, so a 12 MP photo keeps about 62,000 distinct values per channel.

Press `?` in the app for the shortcuts.

## Color

Photos with a profile other than sRGB (an iPhone's Display P3) go through a Display P3 2D canvas before upload and are converted to linear sRGB on the GPU, with colors beyond sRGB kept as components below 0 or above 1. WebKit uploads decoded pixels to WebGL as they are, so without this Safari reads P3 values as sRGB and mutes saturated colors (up to 37 of 255 levels on an iPhone photo).

Looks and tools work in sRGB. For Display P3 output, `develop.frag` pulls a color beyond sRGB toward its own luminance until it fits, applies the look, and pushes the result back out by the same factor. Colors inside sRGB render exactly as in sRGB output, an unedited photo keeps its P3 colors, and a B&W look stays neutral. The views show Display P3 on wide-gamut screens. Chromium keeps a WebGL bitmap's color space, so the views draw bitmaps there. Safari drops it on every route but a CPU readback, so the views read pixels back into a pixel buffer behind a fence, two frames in flight, and draw them into a P3 canvas (`Renderer.readLater`, `ui/viewFrame.ts`). In the Safari 27.2 beta on a 2560 px proxy during a simulated slider drag, that route ran at 56 to 62 frames a second with about 2.6 ms of main-thread work a frame.

HEIC imports in every browser. Where the browser has no decoder (all but Safari), a worker decodes it with [libheif-js](https://github.com/catdad-experiments/libheif-js), loaded with the first HEIC file.

Camera RAW imports too: DNG (including iPhone ProRAW), CR3, CR2, NEF, ARW, RAF, ORF, RW2 and the rest LibRaw reads. A worker decodes it with [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm), loaded with the first RAW file, using the camera's white balance and color matrix in Rec. 2020 primaries. The decode's luminance distribution is matched to the file's embedded camera preview (hue kept), so a RAW opens looking like the camera's picture. Pixels stay in linear light as half floats, including channels above white, which the develop pass clamps at the output's white after Highlights and Shadows. Previews decode at half size when that covers them; a 33 MP ARW exports in about 9 s.

## How rendering works

All engine code is in `src/engine/`.

1. `bake.frag` evaluates every global color operation (white balance, exposure, the preset's film model, selective color, split tone, curves, fade) into a 65³ 32-bit float 3D LUT, one layer per draw. A re-bake is cheap enough that every slider stays live.
2. The LUT input is log-shaped linear light (`shaper` in `color.ts`), so values above white from halation or leaks roll off instead of clipping. Paper white sits on lattice point 43, and the develop pass skips its dither for an edit that changes no colors, which keeps an unedited photo bit-exact.
3. `develop.frag` does the per-pixel work at output resolution: guided-filter local tone (highlights, shadows, clarity, texture), sharpen, halation and bloom from a dual-filter glow pyramid, light leak and vignette in linear light, a tetrahedral LUT lookup, then grain, dust and dithering in display space.
4. Grain is one octave of simplex noise at 1536 × 3^-size cells across the long edge, the same strength at every brightness, independent per channel with Grain Color. Roughness blends in more octaves. It is seeded per photo, so preview and export match.
5. Export decodes the original, renders in 2048 px tiles with shared low-res filter layers, and composites borders in Canvas2D (`border.ts`).

In headless Chromium on an Apple Silicon Mac at 2560×1440, a color slider change (bake and develop) takes about 11 ms, a grain change about 6 ms and a crop change about 8 ms. In Safari 27 the same steps take 18, 8 and 10 ms, and a 24 MP export renders in about 0.4 s before encoding.

## Looks

Presets are look parameters, not stored LUTs (`src/model/catalog.ts`). A look is the parametric film model in `src/engine/look.ts`: film balance, calibration, tone curves, selective color, split tone and a B&W mixer. A look can also carry a free curve per channel, two color grids over hue, lightness and chroma (one before the curves and one after), and a correction lattice of RGB offsets over its input color, added last; `src/model/lookPack.ts` decodes them. The four Lab looks here use the film model alone.

Slider tables (`src/model/catalogSliders.ts`, split into one lazy chunk per look by `tools/sliderChunks.ts`) hold post stages at fixed slider positions, which `applyDims` blends; a state can carry its own lattice (`SLIDER_LATTICES`). None of the Lab looks has one. A tool can take the same structure: a stage per fixed slider value, interpolated in between and chained in a fixed order (`src/engine/tools.ts`). Here every tool runs on its formula (`src/model/toolData.ts` loads no tables).

In a dev build, `window.__studio` exposes probes from `src/dev/lookStats.ts`: `allLookStats()` prints each preset's neutral axis, mid-gray lift, chroma ratio and patch shifts, `presetSheet(name)` renders a contact sheet of every preset on a library photo, and `perfProbe(name)` times the engine.

## Layout

```
src/engine/   color math, looks, geometry, borders, HEIF sniffing, WebGL2 renderer, shaders
src/model/    edit document, presets and look data, crop math
src/store/    library state, IndexedDB, render service, export, HEIC and RAW decoding
src/ui/       React components (rails, panels, slider, crop view, curves)
src/dev/      dev-only probes (look stats, contact sheets, tool sweep, perf)
e2e/          Playwright smoke tests and their synthetic fixtures
tools/        build-time Vite plugin for the slider chunks
```

## License

MIT, see [LICENSE](LICENSE). Third-party code keeps its own license: libheif-js (LGPL-3.0) and LibRaw through libraw-wasm (LibRaw: LGPL-2.1 or CDDL-1.0) load as separate WebAssembly modules; ExifReader is MPL-2.0; Lucide icons are ISC; the Inter font is OFL-1.1.
