// The Lab looks: four looks made for Imaginary, set by hand on the engine's parameters (src/engine/look.ts).
import type { DimKind, LookParams } from '../engine/look'

export interface CatalogFamily { id: string; title: string; color: string; chip: 'fill' | 'stock'; dims: DimKind }
export interface CatalogPreset {
  code: string
  name: string
  family: string
  look: Omit<LookParams, "channelCurves" | "grid" | "gridIn" | "lattice" | "post" | "sliders" | "strengthBase">
  /** Channel curves, uint16 base64 (lookPack.ts). */
  curves?: string
  /** Color grids, int8 base64 (lookPack.ts): after and before the curves. */
  grid?: string
  gridIn?: string
  /** Correction lattice, float32 scale then 12-bit values, base64 (lookPack.ts decodeLattice). */
  lattice?: string
  /** What Strength mixes with where that is not the photo: a lattice from identity, packed like `lattice` (fit_strength_base.py). */
  strengthBase?: string
}

export const CATALOG_FAMILIES: CatalogFamily[] = [
  {
    "id": "lab",
    "title": "Lab",
    "color": "#7b3dff",
    "chip": "fill" as const,
    "dims": "none" as const
  }
]

export const CATALOG: CatalogPreset[] = [
  {"code": "LB1", "name": "Infrared", "family": "lab", "look": {"temperature": 0.0, "tint": 0.0, "exposure": 0.0, "calibration": {"redHue": 0.0, "redSat": 0.135, "greenHue": -1.35, "greenSat": 0.27, "blueHue": 0.0, "blueSat": 0.0}, "tone": {"contrast": 0.216, "pivot": 0.473, "gamma": [0.892, 0.9325, 0.9325], "black": [0.027, 0.0135, 0.027], "white": [0.973, 0.946, 0.9595], "headroom": -0.0105, "toe": 0.27}, "mono": 0, "monoMix": [0.2126, 0.7152, 0.0722], "bwMix": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], "hsl": {"green": {"h": 1.35, "s": 0.405, "l": 0.135}, "yellow": {"h": 1.35, "s": 0.27}, "aqua": {"h": 0.81}, "blue": {"l": -0.27, "s": 0.27}}, "sat": 1.0675, "satShadows": 1.0, "satHighlights": 1.0, "split": {"shadowHue": 220.0, "shadowSat": 0.0, "highlightHue": 45.0, "highlightSat": 0.0, "balance": 0.0}, "skin": {"hue": 0.0, "sat": 0.0}, "scan": [1.0, 1.0, 1.0], "grain": 0, "grainSize": 0, "halation": 0, "density": 0.0, "hueShadows": 0.0, "hueHighlights": 0.0, "chromaKnee": 0.0, "postMatrix": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]}},
  {"code": "LB2", "name": "Duotone", "family": "lab", "look": {"temperature": 0, "tint": 0, "exposure": 0, "calibration": {"redHue": 0, "redSat": 0, "greenHue": 0, "greenSat": 0, "blueHue": 0, "blueSat": 0}, "tone": {"contrast": 0.2, "pivot": 0.5, "gamma": [0.8, 1.05, 1.3], "black": [0.12, 0.02, 0.35], "white": [1, 0.86, 0.45], "headroom": 0, "toe": 0}, "mono": 1, "monoMix": [0.2126, 0.7152, 0.0722], "bwMix": [0, 0, 0, 0, 0, 0, 0, 0], "hsl": {}, "sat": 1, "satShadows": 1, "satHighlights": 1, "split": {"shadowHue": 220, "shadowSat": 0, "highlightHue": 45, "highlightSat": 0, "balance": 0}, "skin": {"hue": 0, "sat": 0}, "scan": [1, 1, 1], "grain": 0, "grainSize": 0, "halation": 0, "density": 0, "hueShadows": 0, "hueHighlights": 0, "chromaKnee": 0, "postMatrix": [0, 0, 0, 0, 0, 0]}},
  {"code": "LB3", "name": "Cyanotype", "family": "lab", "look": {"temperature": 0, "tint": 0, "exposure": 0, "calibration": {"redHue": 0, "redSat": 0, "greenHue": 0, "greenSat": 0, "blueHue": 0, "blueSat": 0}, "tone": {"contrast": 0.22, "pivot": 0.5, "gamma": [1.4, 1.05, 0.8], "black": [0.02, 0.1, 0.25], "white": [0.88, 0.95, 1], "headroom": 0, "toe": 0}, "mono": 1, "monoMix": [0.2126, 0.7152, 0.0722], "bwMix": [0, 0, 0, 0, 0, 0, 0, 0], "hsl": {}, "sat": 1, "satShadows": 1, "satHighlights": 1, "split": {"shadowHue": 220, "shadowSat": 0, "highlightHue": 45, "highlightSat": 0, "balance": 0}, "skin": {"hue": 0, "sat": 0}, "scan": [1, 1, 1], "grain": 0, "grainSize": 0, "halation": 0, "density": 0, "hueShadows": 0, "hueHighlights": 0, "chromaKnee": 0, "postMatrix": [0, 0, 0, 0, 0, 0]}},
  {"code": "LB4", "name": "Shift", "family": "lab", "look": {"temperature": 0.0, "tint": 0.0, "exposure": 0.0, "calibration": {"redHue": 1.45, "redSat": 0.0, "greenHue": 1.45, "greenSat": 0.0, "blueHue": 1.45, "blueSat": 0.0}, "tone": {"contrast": 0.29, "pivot": 0.5, "gamma": [1.0, 1.0, 1.0], "black": [0.029, 0.0145, 0.058], "white": [0.971, 0.942, 0.971], "headroom": -0.0135, "toe": 0.0}, "mono": 0, "monoMix": [0.2126, 0.7152, 0.0722], "bwMix": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], "hsl": {}, "sat": 1.145, "satShadows": 1.0, "satHighlights": 1.0, "split": {"shadowHue": 220.0, "shadowSat": 0.0, "highlightHue": 45.0, "highlightSat": 0.0, "balance": 0.0}, "skin": {"hue": 0.0, "sat": 0.0}, "scan": [1.0, 1.0, 1.0], "grain": 0, "grainSize": 0, "halation": 0, "density": 0.0, "hueShadows": 0.0, "hueHighlights": 0.0, "chromaKnee": 0.0, "postMatrix": [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]}}
]
