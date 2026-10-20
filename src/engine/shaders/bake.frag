// Bakes the global color pipeline into one layer of the look LUT.
// Input grid is log-shaped linear light; output is display-referred sRGB.
precision highp float;
precision highp sampler2D;

uniform float uLayer;      // blue index of this slice
uniform float uSize;       // LUT edge length

// Scene stage (user)
uniform mat3 uWB;          // temperature/tint, linear sRGB
uniform float uExposure;   // stops

// Look stage (preset)
uniform float uLookOn;
uniform float uStrength;
uniform mat3 uLkMatrix;    // stock white balance + calibration
uniform float uLkExposure;
uniform float uLkMono;
uniform vec3 uLkMonoMix;
uniform float uLkHslH[8];
uniform float uLkHslS[8];
uniform float uLkHslL[8];
uniform vec3 uLkSat;       // global, shadows, highlights
uniform vec4 uLkSplit;     // shadow ab, highlight ab
uniform float uLkSplitBalance;
uniform vec2 uLkSkin;
uniform vec3 uLkScan;     // post-curve scanner gains
uniform mat3 uLkPost;     // display-space crosstalk after the curves
uniform float uLkDensity;
uniform float uLkHueShadows;
uniform float uLkHueHighlights;
uniform float uLkChromaKnee;
uniform float uLkBw[8];
uniform float uLkBwOn;
uniform float uLkGridOn;
uniform vec3 uLkGridScale;
uniform float uLkRgbOn;
uniform mat3 uLkRgb;
uniform vec3 uLkRgbOffset;
uniform float uLkGridInOn;
// Color grids: 24 hues x 4 chroma levels wide, 7 lightness rows; rgb = hue, log chroma, lightness.
// uLkGridIn acts on the input color before the curves, uLkGrid on the output after them.
uniform sampler2D uLkGrid;
uniform sampler2D uLkGridIn;
// Post stage (how a slider moves the look): curve rows 7-9, chroma by lightness, coarse grid
// (12 hues x 2 chroma levels wide, 4 lightness rows).
uniform float uLkPostOn;
uniform float uLkPostAfter; // 1: the post stage runs after the correction lattice (hand-built dims on a lattice look)
uniform vec3 uLkPostSat;
uniform sampler2D uLkPostGrid;
uniform float uLkPostInOn;
uniform vec4 uLkPostFilter; // B&W color filter: amount, then display-space R, G, B weights
uniform sampler2D uLkPostGridIn; // same lattice, on the input color before B&W conversion
// Correction lattice: n x n x n RGB offsets over the look's input color (n = uLkLatticeN, 9 to 13),
// node (r, g, b) at texel (r + n * g, b); the look's own plus its slider state's, added after everything else.
uniform float uLkLatticeOn;
uniform int uLkLatticeN;
uniform sampler2D uLkLattice;
// Strength base: what Strength mixes the look with where that is not the photo (gray for B&W looks), as the input color
// plus a lattice in the same layout (n = uLkBaseN), indexed by the input color.
uniform float uLkBaseOn;
uniform int uLkBaseN;
uniform sampler2D uLkBaseLattice;

// Tool stages (fitted tools): exposure, temperature, tint, contrast, saturation, skin tone, fade.
uniform float uToolsStaged;
uniform float uToolOn[7];
uniform float uToolInOn[7];
uniform float uToolHslOn;
// Per tool: 7 rows of output grid, then 7 rows of input grid (same layout as uLkGrid).
uniform sampler2D uToolGrids;

// Post stage (user)
uniform float uHslH[8];
uniform float uHslS[8];
uniform float uHslL[8];
uniform float uSaturation;
uniform float uVibrance;
uniform float uDensity;
uniform float uBwOn;
uniform float uBw[8];
uniform float uSkinTone;
uniform vec4 uSplit;
uniform float uSplitBalance;
uniform float uContrast;
uniform float uWhites;
uniform float uBlacks;
uniform float uFade;
uniform float uCurvesOn;

// Rows: 0-2 look tone curve R,G,B over [0,2]; 3-6 user master,R,G,B over [0,1]; 7-9 look post stage R,G,B over [0,1].
uniform sampler2D uCurves;

out vec4 outColor;

// Pro slider states blended by output (look.ts proTerms): uLkTermCount terms, each with its own post stage (curve rows
// from 32, post grid block k) and uLkTerms column k: (weight, saturation), B&W filter, (input grid on, identity, cache
// slot or -1, 0). A cached term's look was baked at this same lattice point: uTermLut at depth slot * uSize + layer
// (Renderer.termCache).
uniform int uLkTermCount;
uniform sampler2D uLkTerms;
const int TERM_CURVE_ROW = 32;  // params.ts TERM_CURVE_ROW
const int MAX_POST_TERMS = 12;  // look.ts MAX_POST_TERMS
uniform highp sampler3D uTermLut;
// >= 0: write that term's look alone (filling its cache slot); -1: the full bake.
uniform int uTermPass;

float curveRow(float x, int row, float domain) {
  float n = float(textureSize(uCurves, 0).x);
  float u = clamp(x / domain, 0.0, 1.0) * (n - 1.0);
  float i0 = floor(u);
  float f = u - i0;
  float a = texelFetch(uCurves, ivec2(int(i0), row), 0).r;
  float b = texelFetch(uCurves, ivec2(int(min(i0 + 1.0, n - 1.0)), row), 0).r;
  return mix(a, b, f);
}

// Neutral render used when strength is 0: an exact identity so an unedited
// photo round-trips. Light pushed past white by effects clips here; looks
// roll it off through their own shoulder instead.
vec3 neutralRender(vec3 lin) {
  return min(srgbEncode(lin), 1.0);
}

float logistic(float x) { return 1.0 / (1.0 + exp(-x)); }
float sCurve(float v, float c, float pivot) {
  if (abs(c) < 1e-4) return v;
  float k = abs(c) * 9.0;
  float l0 = logistic(-k * pivot);
  float l1 = logistic(k * (1.0 - pivot));
  if (c > 0.0) return (logistic(k * (v - pivot)) - l0) / (l1 - l0);
  float y = clamp(l0 + v * (l1 - l0), 1e-6, 1.0 - 1e-6);
  return log(y / (1.0 - y)) / k + pivot;
}

// Film behaviors a plain tone curve cannot make (fitted against real stocks):
// tone-dependent hue crossover, soft chroma roll-off, and dye density.
vec3 filmExtras(vec3 lab) {
  float L = clamp(lab.x, 0.0, 1.0);
  if (uLkHueShadows != 0.0 || uLkHueHighlights != 0.0) {
    float rot = radians(uLkHueShadows * 25.0 * (1.0 - smoothstep(0.15, 0.6, L)) + uLkHueHighlights * 25.0 * smoothstep(0.5, 0.95, L));
    float c = cos(rot), s = sin(rot);
    lab.yz = vec2(lab.y * c - lab.z * s, lab.y * s + lab.z * c);
  }
  float C = length(lab.yz);
  if (uLkChromaKnee > 0.0) {
    float k = 1.0 / (1.0 + uLkChromaKnee * 6.0 * C);
    lab.yz *= k;
    C *= k;
  }
  if (uLkDensity > 0.0) lab.x -= uLkDensity * 0.3 * C * smoothstep(0.05, 0.45, L);
  return lab;
}

const float GRID_L[7] = float[7](0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95);
const float GRID_C[4] = float[4](0.02, 0.06, 0.12, 0.2);
const vec3 GRID_RANGE = vec3(45.0, 1.5, 0.2);

// Position on a lattice axis: lower knot and fraction, clamped at the ends.
void gridAxis7(float v, out int i0, out float f) {
  i0 = 0;
  f = 0.0;
  if (v >= GRID_L[6]) { i0 = 5; f = 1.0; return; }
  for (int i = 0; i < 6; i++)
    if (v >= GRID_L[i] && v < GRID_L[i + 1]) { i0 = i; f = (v - GRID_L[i]) / (GRID_L[i + 1] - GRID_L[i]); }
}
void gridAxis4(float v, out int i0, out float f) {
  i0 = 0;
  f = 0.0;
  if (v >= GRID_C[3]) { i0 = 2; f = 1.0; return; }
  for (int i = 0; i < 3; i++)
    if (v >= GRID_C[i] && v < GRID_C[i + 1]) { i0 = i; f = (v - GRID_C[i]) / (GRID_C[i + 1] - GRID_C[i]); }
}

// Fitted color grid: hue, chroma and lightness moves that depend on all three,
// which is what lets a look track how a real stock treats each color.
vec3 applyGridRows(vec3 lab, sampler2D grid, int rowBase, vec3 range);

// Look grids: ranges widened per look (gridScale) for looks that swap hues.
vec3 applyGrid(vec3 lab, sampler2D grid) {
  return applyGridRows(lab, grid, 0, GRID_RANGE * uLkGridScale);
}

vec3 applyGridRows(vec3 lab, sampler2D grid, int rowBase, vec3 range) {
  float C = length(lab.yz);
  if (C < 1e-6) return lab; // hue is undefined on the neutral axis, and the grid is gated off there
  float hue = degrees(atan(lab.z, lab.y));
  if (hue < 0.0) hue += 360.0;
  float hp = hue / 15.0;
  int h0 = int(floor(hp)) % 24;
  int h1 = (h0 + 1) % 24;
  float fh = hp - floor(hp);
  int l0, c0;
  float fl, fc;
  gridAxis7(clamp(lab.x, 0.0, 1.0), l0, fl);
  gridAxis4(C, c0, fc);
  vec3 v = vec3(0.0);
  for (int dl = 0; dl < 2; dl++)
    for (int dc = 0; dc < 2; dc++) {
      float w = (dl == 1 ? fl : 1.0 - fl) * (dc == 1 ? fc : 1.0 - fc);
      int row = rowBase + l0 + dl;
      int c = c0 + dc;
      v += w * (1.0 - fh) * texelFetch(grid, ivec2(h0 * 4 + c, row), 0).rgb;
      v += w * fh * texelFetch(grid, ivec2(h1 * 4 + c, row), 0).rgb;
    }
  v *= range * smoothstep(0.0, 0.03, C);
  float h2 = radians(hue + v.x);
  float C2 = C * exp(v.y);
  return vec3(lab.x + v.z, C2 * cos(h2), C2 * sin(h2));
}

const float POST_L[4] = float[4](0.15, 0.45, 0.75, 0.95);
const float POST_C[2] = float[2](0.04, 0.12);
const vec3 POST_RANGE = vec3(30.0, 1.0, 0.1);

// block: which stage's POST_L rows (the post stage's is 0; a Pro term's is its index).
vec3 applyPostGrid(vec3 lab, sampler2D grid, int block) {
  float L = clamp(lab.x, 0.0, 1.0);
  float C = length(lab.yz);
  if (C > 1e-6) {
    float hue = degrees(atan(lab.z, lab.y));
    if (hue < 0.0) hue += 360.0;
    float hp = hue / 30.0;
    int h0 = int(floor(hp)) % 12;
    int h1 = (h0 + 1) % 12;
    float fh = hp - floor(hp);
    int l0 = 0;
    float fl = 0.0;
    if (L >= POST_L[3]) { l0 = 2; fl = 1.0; }
    else for (int i = 0; i < 3; i++)
      if (L >= POST_L[i] && L < POST_L[i + 1]) { l0 = i; fl = (L - POST_L[i]) / (POST_L[i + 1] - POST_L[i]); }
    float fc = clamp((C - POST_C[0]) / (POST_C[1] - POST_C[0]), 0.0, 1.0);
    vec3 v = vec3(0.0);
    for (int dl = 0; dl < 2; dl++)
      for (int dc = 0; dc < 2; dc++) {
        float w = (dl == 1 ? fl : 1.0 - fl) * (dc == 1 ? fc : 1.0 - fc);
        v += w * (1.0 - fh) * texelFetch(grid, ivec2(h0 * 2 + dc, block * 4 + l0 + dl), 0).rgb;
        v += w * fh * texelFetch(grid, ivec2(h1 * 2 + dc, block * 4 + l0 + dl), 0).rgb;
      }
    v *= POST_RANGE * smoothstep(0.0, 0.03, C);
    float h2 = radians(hue + v.x);
    float C2 = C * exp(v.y);
    lab = vec3(lab.x + v.z, C2 * cos(h2), C2 * sin(h2));
  }
  return lab;
}

vec3 latticeIn(sampler2D lattice, int n, vec3 v) {
  vec3 p = clamp(v, 0.0, 1.0) * float(n - 1);
  ivec3 i = min(ivec3(floor(p)), ivec3(n - 2));
  vec3 f = p - vec3(i);
  vec3 acc = vec3(0.0);
  for (int db = 0; db < 2; db++)
    for (int dg = 0; dg < 2; dg++)
      for (int dr = 0; dr < 2; dr++) {
        float w = (dr == 1 ? f.x : 1.0 - f.x) * (dg == 1 ? f.y : 1.0 - f.y) * (db == 1 ? f.z : 1.0 - f.z);
        acc += w * texelFetch(lattice, ivec2(i.x + dr + n * (i.y + dg), i.z + db), 0).rgb;
      }
  return acc;
}

vec3 latticeAt(vec3 v) {
  return latticeIn(uLkLattice, uLkLatticeN, v);
}

// A post stage: its curves (rows row..row+2), saturation, and grid block.
vec3 applyPost(vec3 d, int row, vec3 sat, int block) {
  d = clamp(vec3(curveRow(d.r, row, 1.0), curveRow(d.g, row + 1, 1.0), curveRow(d.b, row + 2, 1.0)), 0.0, 1.0);
  vec3 lab = linToOklab(srgbDecode(d));
  float L = clamp(lab.x, 0.0, 1.0);
  lab.yz *= exp(sat.x + sat.y * (1.0 - smoothstep(0.1, 0.5, L)) + sat.z * smoothstep(0.6, 1.0, L));
  return clamp(srgbEncode(oklabToLin(applyPostGrid(lab, uLkPostGrid, block))), 0.0, 1.0);
}

// The look after its own input grid: a slider state's input grid and B&W filter, the tone curves, the color
// stages and the post stage. term < 0: the post stage, if any (film tables, hand-built dims); else Pro term `term`.
vec3 lookTail(vec3 lin, vec3 lin0, int term) {
  vec4 filt = uLkPostFilter;
  vec4 flags = vec4(0.0);
  if (term < 0) {
    if (uLkPostInOn > 0.5) lin = max(oklabToLin(applyPostGrid(linToOklab(lin), uLkPostGridIn, 0)), 0.0);
  } else {
    filt = texelFetch(uLkTerms, ivec2(term, 1), 0);
    flags = texelFetch(uLkTerms, ivec2(term, 2), 0);
    if (flags.x > 0.5) lin = max(oklabToLin(applyPostGrid(linToOklab(lin), uLkPostGridIn, term)), 0.0);
  }
  if (uLkMono > 0.0) {
    // B&W: a channel mix for the base gray, then a per-hue mixer (a filter
    // per color family), which a linear mix alone cannot express.
    vec3 mixw = uLkMonoMix / max(dot(uLkMonoMix, vec3(1.0)), 1e-4);
    float base = max(dot(lin, mixw), 0.0);
    if (uLkBwOn > 0.5) {
      vec3 lab = linToOklab(lin);
      float C = length(lab.yz);
      if (C > 1e-5) {
        float hue = degrees(atan(lab.z, lab.y));
        if (hue < 0.0) hue += 360.0;
        float w[8];
        bandWeights(hue, w);
        float sh = 0.0;
        for (int i = 0; i < 8; i++) sh += w[i] * uLkBw[i];
        float Lb = pow(base, 1.0 / 3.0) + sh * 0.35 * smoothstep(0.0, 0.12, C);
        base = pow(max(Lb, 0.0), 3.0);
      }
    }
    if (filt.x > 0.0) {
      // A Pro slider's color filter: a display-space channel mix of the input, blended into the gray.
      float g = clamp(dot(filt.yzw, srgbEncode(max(lin0, 0.0))), 0.0, 1.0);
      float b = srgbEncode(vec3(clamp(base, 0.0, 1.0))).x;
      base = srgbDecode(vec3(mix(b, g, filt.x))).x;
    }
    lin = mix(lin, vec3(base), uLkMono);
  }
  vec3 v = srgbEncode(lin);
  vec3 d = vec3(curveRow(v.r, 0, 2.0), curveRow(v.g, 1, 2.0), curveRow(v.b, 2, 2.0));
  d = clamp(d * uLkScan, 0.0, 1.0);
  d = clamp(uLkPost * d, 0.0, 1.0);

  vec3 lab = linToOklab(srgbDecode(d));
  lab = applyHsl(lab, uLkHslH, uLkHslS, uLkHslL);
  lab = applySkin(lab, uLkSkin.x, uLkSkin.y);
  float L = clamp(lab.x, 0.0, 1.0);
  float satL = uLkSat.x * mix(uLkSat.y, 1.0, smoothstep(0.1, 0.5, L)) * mix(1.0, uLkSat.z, smoothstep(0.6, 1.0, L));
  // Mono was applied in linear before the curves; chroma here is toning from
  // tinted curves and split tone, so it must survive.
  lab.yz *= satL;
  if (uLkGridOn > 0.5) lab = applyGrid(lab, uLkGrid);
  lab = filmExtras(lab);
  lab = applySplit(lab, uLkSplit.xy, uLkSplit.zw, uLkSplitBalance);
  vec3 look = clamp(srgbEncode(oklabToLin(lab)), 0.0, 1.0);
  if (term < 0) {
    if (uLkPostOn > 0.5 && uLkPostAfter < 0.5) look = applyPost(look, 7, uLkPostSat, 0);
  } else if (flags.y < 0.5) {
    look = applyPost(look, TERM_CURVE_ROW + 3 * term, texelFetch(uLkTerms, ivec2(term, 0), 0).yzw, term);
  }
  return look;
}

// The look's input stages, shared by every term: returns the color the correction lattice is indexed by.
vec3 lookPrefix(inout vec3 lin, out vec3 lin0) {
  vec3 vIn = clamp(srgbEncode(max(lin, 0.0)), 0.0, 1.0);
  // Distortion looks: display RGB through a matrix plus offset, clipped, before anything else.
  if (uLkRgbOn > 0.5) lin = srgbDecode(clamp(uLkRgb * srgbEncode(lin) + uLkRgbOffset, 0.0, 1.0));
  lin = max(uLkMatrix * lin, 0.0) * exp2(uLkExposure);
  lin0 = lin;
  if (uLkGridInOn > 0.5) lin = max(oklabToLin(applyGrid(linToOklab(lin), uLkGridIn)), 0.0);
  return vIn;
}

vec3 lookRender(vec3 lin) {
  vec3 lin0;
  vec3 vIn = lookPrefix(lin, lin0);
  vec3 look;
  if (uLkTermCount > 0) {
    // Pro sliders: each captured state's look, blended by the terms' weights (affine, so clamped after).
    look = vec3(0.0);
    for (int k = 0; k < MAX_POST_TERMS; k++) {
      if (k >= uLkTermCount) break;
      vec4 t = texelFetch(uLkTerms, ivec2(k, 2), 0);
      vec3 term = t.z >= 0.0 ? texelFetch(uTermLut, ivec3(ivec2(gl_FragCoord.xy), int(t.z) * int(uSize) + int(uLayer)), 0).rgb
                             : lookTail(lin, lin0, k);
      look += texelFetch(uLkTerms, ivec2(k, 0), 0).x * term;
    }
    look = clamp(look, 0.0, 1.0);
  } else {
    look = lookTail(lin, lin0, -1);
  }
  if (uLkLatticeOn > 0.5) look = clamp(look + latticeAt(vIn), 0.0, 1.0);
  if (uLkPostOn > 0.5 && uLkPostAfter > 0.5) look = applyPost(look, 7, uLkPostSat, 0);
  return look;
}

vec3 postRender(vec3 d) {
  vec3 lab = linToOklab(srgbDecode(d));
  lab = applyHsl(lab, uHslH, uHslS, uHslL);
  lab = applySkin(lab, uSkinTone, uSkinTone * 0.35);

  float C = length(lab.yz);
  // Vibrance: boost muted colors most, protect skin and already vivid ones.
  if (uVibrance != 0.0) {
    float hue = degrees(atan(lab.z, lab.y));
    float skin = exp(-pow(hueDist(hue < 0.0 ? hue + 360.0 : hue, 58.0) / 25.0, 2.0));
    float k = uVibrance * (1.0 - smoothstep(0.0, 0.25, C)) * (1.0 - 0.6 * skin);
    lab.yz *= max(0.0, 1.0 + k * (uVibrance > 0.0 ? 0.9 : 1.0));
  }
  lab.yz *= max(0.0, 1.0 + uSaturation * (uSaturation > 0.0 ? 0.8 : 1.0));
  // Density: richer, darker saturated colors (film dye behavior), with a
  // little extra chroma so the color reads deep rather than dull.
  if (uDensity > 0.0) {
    float Cd = length(lab.yz);
    lab.x -= uDensity * 0.3 * Cd * smoothstep(0.05, 0.45, clamp(lab.x, 0.0, 1.0));
    lab.yz *= 1.0 + uDensity * 0.12;
  }
  // Black & white with a per-hue mixer; split tone below then tones it.
  if (uBwOn > 0.5) {
    float C = length(lab.yz);
    float Lb = lab.x;
    if (C > 1e-5) {
      float hue = degrees(atan(lab.z, lab.y));
      if (hue < 0.0) hue += 360.0;
      float w[8];
      bandWeights(hue, w);
      float sh = 0.0;
      for (int i = 0; i < 8; i++) sh += w[i] * uBw[i];
      Lb += sh * 0.35 * smoothstep(0.0, 0.12, C);
    }
    lab = vec3(Lb, 0.0, 0.0);
  }
  lab = applySplit(lab, uSplit.xy, uSplit.zw, uSplitBalance);

  // Contrast on lightness around mid gray (Oklab L of 18% gray ~ 0.565),
  // chroma follows a little so the image does not wash out.
  float L0 = clamp(lab.x, 0.0, 1.0);
  float L1 = L0;
  if (uContrast != 0.0) L1 = sCurve(L1, uContrast * 0.55, 0.565);
  // Whites and blacks move the ends of the lightness range with a smooth
  // falloff into the mids; hue and saturation stay put.
  L1 += uWhites * 0.13 * smoothstep(0.45, 1.0, L1) + uBlacks * 0.1 * (1.0 - smoothstep(0.0, 0.6, L1));
  if (L1 != L0) {
    lab.yz *= mix(1.0, (L1 + 0.05) / (L0 + 0.05), 0.35);
    lab.x = L1;
  }
  vec3 o = srgbEncode(oklabToLin(lab));

  if (uCurvesOn > 0.5) {
    o = clamp(o, 0.0, 1.0);
    o = vec3(curveRow(o.r, 3, 1.0), curveRow(o.g, 3, 1.0), curveRow(o.b, 3, 1.0));
    o = vec3(curveRow(o.r, 4, 1.0), curveRow(o.g, 5, 1.0), curveRow(o.b, 6, 1.0));
  }

  // Fade lifts the black point with a soft toe (film base fog).
  if (uFade > 0.0) {
    float lift = uFade * 0.24;
    o = lift + (1.0 - lift * 0.35) * o - lift * o * (1.0 - o) * 0.6;
  }
  return clamp(o, 0.0, 1.0);
}

// HSL as in the fit (Python colorsys): used by Saturation's curve.
vec3 rgbToHls(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float l = (mx + mn) * 0.5;
  if (mx - mn < 1e-7) return vec3(0.0, l, 0.0);
  float d = mx - mn;
  float s = l <= 0.5 ? d / (mx + mn) : d / (2.0 - mx - mn);
  vec3 rc = (vec3(mx) - c) / d;
  float h;
  if (c.r == mx) h = rc.b - rc.g;
  else if (c.g == mx) h = 2.0 + rc.r - rc.b;
  else h = 4.0 + rc.g - rc.r;
  return vec3(fract(h / 6.0), l, s);
}
float hlsV(float m1, float m2, float h) {
  h = fract(h);
  if (h < 1.0 / 6.0) return m1 + (m2 - m1) * h * 6.0;
  if (h < 0.5) return m2;
  if (h < 2.0 / 3.0) return m1 + (m2 - m1) * (2.0 / 3.0 - h) * 6.0;
  return m1;
}
vec3 hlsToRgb(vec3 hls) {
  if (hls.z <= 0.0) return vec3(hls.y);
  float m2 = hls.y <= 0.5 ? hls.y * (1.0 + hls.z) : hls.y + hls.z - hls.y * hls.z;
  float m1 = 2.0 * hls.y - m2;
  return vec3(hlsV(m1, m2, hls.x + 1.0 / 3.0), hlsV(m1, m2, hls.x), hlsV(m1, m2, hls.x - 1.0 / 3.0));
}

// One fitted tool stage on display values in 0..1 (same structure as a fitted look).
vec3 toolStage(vec3 v, int i) {
  if (i == 4 && uToolHslOn > 0.5) {
    vec3 hls = rgbToHls(v);
    hls.z = curveRow(hls.z, 31, 1.0);
    v = hlsToRgb(hls);
  }
  vec3 lin = srgbDecode(v);
  if (uToolInOn[i] > 0.5) lin = max(oklabToLin(applyGridRows(linToOklab(lin), uToolGrids, i * 14 + 7, GRID_RANGE)), 0.0);
  v = srgbEncode(lin);
  int r = 10 + i * 3;
  v = clamp(vec3(curveRow(v.r, r, 1.0), curveRow(v.g, r + 1, 1.0), curveRow(v.b, r + 2, 1.0)), 0.0, 1.0);
  vec3 lab = applyGridRows(linToOklab(srgbDecode(v)), uToolGrids, i * 14, GRID_RANGE);
  return clamp(srgbEncode(oklabToLin(lab)), 0.0, 1.0);
}

// Pre tools (exposure, temperature, tint) act on the input before the look. Light
// pushed past white by effects rides along unchanged above the stages.
vec3 preTools(vec3 lin) {
  vec3 v = srgbEncode(max(lin, 0.0));
  vec3 over = max(v - 1.0, 0.0);
  v = min(v, 1.0);
  for (int i = 0; i < 3; i++)
    if (uToolOn[i] > 0.5) v = toolStage(v, i);
  return srgbDecode(v + over);
}

// Post tools (contrast, saturation, skin tone, fade) act right after the look.
vec3 postTools(vec3 d) {
  for (int i = 3; i < 7; i++)
    if (uToolOn[i] > 0.5) d = toolStage(d, i);
  return d;
}

void main() {
  vec3 idx = vec3(floor(gl_FragCoord.xy), uLayer);
  vec3 shaped = idx / (uSize - 1.0);
  vec3 lin = shaperInv(shaped);

  lin = max(uWB * lin, 0.0) * exp2(uExposure);
  if (uToolsStaged > 0.5) lin = preTools(lin);
  if (uTermPass >= 0) {
    vec3 lin0;
    lookPrefix(lin, lin0);
    outColor = vec4(lookTail(lin, lin0, uTermPass), 1.0);
    return;
  }

  vec3 base = neutralRender(lin);
  vec3 d = base;
  if (uLookOn > 0.5) {
    // At Strength 1 mix returns the look exactly; below it, the look's base where it has one.
    vec3 from = uLkBaseOn > 0.5 ? clamp(base + latticeIn(uLkBaseLattice, uLkBaseN, base), 0.0, 1.0) : base;
    d = mix(from, lookRender(lin), uStrength);
  }
  if (uToolsStaged > 0.5) d = postTools(d);
  d = postRender(d);
  outColor = vec4(d, 1.0);
}
