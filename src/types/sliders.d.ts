declare module 'virtual:slider-index' {
  export interface PackedTable {
    sliders: string
    lattices: string
  }
  export const loaders: Record<string, () => Promise<PackedTable>>
}
