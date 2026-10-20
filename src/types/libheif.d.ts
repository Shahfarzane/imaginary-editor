// The slice of libheif-js (libheif compiled to WebAssembly, wasm inlined) that the HEIC worker uses.
declare module 'libheif-js/libheif-wasm/libheif-bundle.mjs' {
  interface HeifImage {
    get_width(): number
    get_height(): number
    is_primary(): boolean
    display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (out: unknown) => void): void
    free(): void
  }
  interface LibHeif {
    HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] }
  }
  const factory: () => LibHeif
  export default factory
}
