// Main per-pixel pass at output resolution.
// Linear light:  local tone (highlights, shadows, clarity, texture), sharpen,
//                halation, bloom, light leak, lens vignette.
// LUT:           log-shaped input -> baked look -> display sRGB.
// Display:       grain, dust, dither.
precision highp float;
precision highp sampler3D;

uniform sampler2D uWork;      // linear working image, same size as output
uniform sampler2D uBaseCoef;  // guided filter a,b (large radius)
uniform sampler2D uMidCoef;   // guided filter a,b (clarity radius)
uniform sampler2D uFineCoef;  // guided filter a,b (texture radius)
uniform sampler2D uGlow;      // rgb bloom, a halation
uniform highp sampler3D uLut;

uniform vec2 uOutSize;
uniform vec2 uImageOffset;    // for tiled export: pixel offset of this tile
uniform vec2 uImageSize;      // full image size in pixels (== uOutSize unless tiled)
uniform float uGrainFull;     // long edge of the full-resolution image the grain emulates (0: unknown)
uniform ivec2 uWorkPad;       // padding of uWork around this tile (for sharpen)

uniform float uRawExposure;   // RAW Exposure, stops: light scaled ahead of the tone tools and the white clamp
uniform float uHighlights, uShadows, uClarity, uTexture, uSharpen;
uniform float uLocalOn;
uniform float uHalation, uHalationSpread, uBloom, uGlowOn;
uniform float uVignette, uVignetteFeather;
uniform float uLeak, uLeakWarmth;
uniform float uGrain, uGrainSize, uGrainRough, uGrainColor;
uniform float uDust;
uniform float uSeed;
uniform float uDither;        // one output level: 1/255 for 8-bit targets, 1/65535 for 16-bit exports
uniform float uOutP3;         // 1: encode Display P3 and keep colors beyond sRGB; 0: sRGB, where they clip
uniform float uClampWhite;    // 1: the source holds channels above white (camera RAW); clamp them after local tone
uniform mat3 uSrgbToP3;
uniform mat3 uP3ToSrgb;

out vec4 outColor;

float luma(vec3 c) { return dot(c, LUMA); }

vec2 imagePx() { return gl_FragCoord.xy + uImageOffset; }
// Resolution-independent image coordinate: 0..1 across the long edge.
vec2 imageUnit() { return imagePx() / max(uImageSize.x, uImageSize.y); }
vec2 imageUv() { return imagePx() / uImageSize; }

float guided(sampler2D coef, vec2 uv, float I) {
  vec2 ab = texture(coef, uv).rg;
  return ab.x * I + ab.y;
}

// lin is the work image as it is; the tools act on it exposed by ev stops. The guided filters were built on the
// unexposed image, and exposure is a shift in log2 luminance, so layers are read at I and their masks at I + ev.
vec3 localTone(vec3 lin, vec2 uv, float ev) {
  float Y = luma(lin);
  float I = log2(Y + 1.0 / 1024.0);
  float base = guided(uBaseCoef, uv, I);
  float L = I;

  // Shadows and highlights reshape the smooth base layer, so detail rides
  // on top untouched: little haloing, no flattening of texture.
  // Masks on the base layer in log2 luminance (mid gray = -2.47).
  float sw = 1.0 - smoothstep(-5.8, -2.3, base + ev);
  float hw = smoothstep(-2.0, 0.1, base + ev);
  float nb = base;
  nb += uShadows * sw * (uShadows > 0.0 ? 1.6 : 1.1);
  nb += uHighlights * hw * (uHighlights > 0.0 ? 0.9 : 1.5);
  L += nb - base;

  if (uClarity != 0.0) {
    float mid = guided(uMidCoef, uv, I);
    float detail = I - mid;
    float m = smoothstep(-8.0, -4.0, I + ev) * (1.0 - smoothstep(-0.6, 0.5, I + ev));
    L += detail * uClarity * 0.9 * m;
  }
  if (uTexture != 0.0) {
    float fine = guided(uFineCoef, uv, I);
    L += (I - fine) * uTexture * 1.1;
  }
  float ratio = exp2(L - I);
  // Near black the ratio is unstable; fade it out.
  ratio = mix(1.0, ratio, smoothstep(0.0, 0.002, Y * exp2(ev)));
  return lin * exp2(ev) * ratio;
}

vec3 sharpen(vec3 lin, ivec2 p) {
  ivec2 s = textureSize(uWork, 0) - 1;
  p += uWorkPad;
  // The neighbours at the same exposure as lin.
  float k = exp2(uRawExposure);
  vec3 n = (texelFetch(uWork, clamp(p + ivec2(1, 0), ivec2(0), s), 0).rgb
         + texelFetch(uWork, clamp(p + ivec2(-1, 0), ivec2(0), s), 0).rgb
         + texelFetch(uWork, clamp(p + ivec2(0, 1), ivec2(0), s), 0).rgb
         + texelFetch(uWork, clamp(p + ivec2(0, -1), ivec2(0), s), 0).rgb) * k;
  vec3 c = texelFetch(uWork, p, 0).rgb * k;
  // Work in perceptual luma so the effect is even across tones.
  float y = srgbEncode1(luma(c));
  float yb = srgbEncode1(luma(n * 0.25));
  float d = y - yb;
  d *= smoothstep(0.003, 0.012, abs(d)); // ignore noise
  float yl = srgbEncode1(luma(lin));
  float target = max(yl + d * uSharpen * 1.6, 0.0);
  float linTarget = target <= 0.04045 ? target / 12.92 : pow((target + 0.055) / 1.055, 2.4);
  return lin * (linTarget / max(luma(lin), 1e-5));
}

vec3 lightLeak(vec2 uv) {
  float aspect = uImageSize.x / uImageSize.y;
  vec3 h = hash33(vec3(uSeed, 11.0, 3.0));
  // Pick an edge and a position along it.
  float edge = floor(h.x * 4.0);
  vec2 c = edge < 1.0 ? vec2(0.0, h.y) : edge < 2.0 ? vec2(1.0, h.y) : edge < 3.0 ? vec2(h.y, 0.0) : vec2(h.y, 1.0);
  vec2 d = (uv - c) * vec2(aspect, 1.0);
  float stretch = 1.6 + h.z * 1.8;
  vec2 axis = edge < 2.0 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  float along = dot(d, vec2(axis.y, axis.x));
  float across = dot(d, axis);
  float r = length(vec2(across, along / stretch));
  float n = simplex3(vec3(uv * 2.2, uSeed * 0.37)) * 0.5 + 0.5;
  float core = exp(-r * r / 0.035) * (0.6 + 0.8 * n);
  float halo = exp(-r * r / 0.22) * (0.5 + 0.5 * n);
  // Secondary soft flare on the opposite side.
  vec2 c2 = vec2(1.0) - c;
  float r2 = length((uv - c2) * vec2(aspect, 1.0));
  float flare = exp(-r2 * r2 / 0.12) * 0.25 * h.z;
  float w = uLeakWarmth;
  vec3 deep = mix(vec3(0.9, 0.05, 0.35), vec3(1.0, 0.12, 0.02), w * 0.5 + 0.5);
  vec3 warm = mix(vec3(1.0, 0.35, 0.3), vec3(1.0, 0.55, 0.12), w * 0.5 + 0.5);
  vec3 hot = vec3(1.0, 0.85, 0.55);
  return deep * halo * 1.4 + warm * core * 2.2 + hot * core * core * 1.5 + warm * flare;
}

float vignetteMask(vec2 uv) {
  float aspect = uImageSize.x / uImageSize.y;
  vec2 d = (uv - 0.5) * 2.0;
  // Follow the frame shape but round it off toward a circle.
  d.x *= mix(1.0, aspect, 0.35) / max(1.0, mix(1.0, aspect, 0.35));
  d.y *= mix(1.0, 1.0 / aspect, 0.35) / max(1.0, mix(1.0, 1.0 / aspect, 0.35));
  float r = length(d) / 1.4142;
  float inner = mix(0.05, 0.62, 0.5 - uVignetteFeather * 0.5);
  return smoothstep(inner, 1.05, r);
}

// Grain: one octave of simplex noise at
// 1536 * 3^-size cells across the long edge, added in display space with the
// same strength at every brightness. Grain Color swaps in independent noise per
// channel. Roughness (ours) blends in coarser and finer octaves.
float grainNoise(vec3 p) {
  float n = simplex3(p);
  if (uGrainRough <= 0.0) return n;
  float multi = (simplex3(p) * 0.62 + simplex3(vec3(p.xy * 2.07, p.z + 17.0)) * 0.46 + simplex3(vec3(p.xy * 0.52, p.z + 31.0)) * 0.55) / 0.98;
  return mix(n, multi, uGrainRough);
}

vec3 grain(vec3 d) {
  float freq = 1536.0 * pow(3.0, -uGrainSize);
  // At full resolution the noise is sampled as is: cells finer than a pixel alias into
  // white noise at full strength. Smaller renders stop at ~1.2 px
  // per cell with the amplitude a downsample of the full-size grain would leave.
  float renderMax = max(uImageSize.x, uImageSize.y);
  float maxFreq = renderMax / 1.2;
  float amp = 1.0;
  bool full = uGrainFull > 0.0 && renderMax >= uGrainFull * 0.999;
  if (!full && freq > maxFreq) {
    float fullFreq = uGrainFull > 0.0 ? min(freq, uGrainFull) : freq;
    amp = min(1.0, maxFreq / fullFreq);
    freq = maxFreq;
  }
  vec2 q = imageUnit() * freq;
  float seed = fract(uSeed * 0.0137) * 100.0;
  vec3 g = vec3(grainNoise(vec3(q, seed)));
  if (uGrainColor > 0.0) {
    vec3 c = vec3(grainNoise(vec3(q, seed + 41.0)), grainNoise(vec3(q, seed + 83.0)), grainNoise(vec3(q, seed + 127.0)));
    g = mix(g, c, uGrainColor);
  }
  return d + g * uGrain * 0.3 * amp;
}

vec3 dust(vec3 d) {
  vec2 p = imageUnit();
  float cells = 26.0;
  vec2 cell = floor(p * cells);
  float px = 1.0 / max(uImageSize.x, uImageSize.y);
  float light = 0.0, dark = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 c = cell + vec2(i, j);
      vec3 h = hash33(vec3(c, uSeed + 5.0));
      if (h.x > uDust * 0.55) continue;
      vec3 h2 = hash33(vec3(c, uSeed + 9.0));
      vec2 center = (c + h.yz) / cells;
      float rad = mix(0.0005, 0.0026, h2.x * h2.x);
      if (h2.z < 0.25) {
        // A short scratch.
        vec2 dir = normalize(h2.xy - 0.5 + 1e-4);
        vec2 rel = p - center;
        float t = clamp(dot(rel, dir), -0.02 * h2.y, 0.02 * h2.y);
        float dist = length(rel - dir * t);
        float m = 1.0 - smoothstep(px * 0.4, px * 1.4 + 0.00025, dist);
        light = max(light, m * 0.7);
      } else {
        float dist = length(p - center);
        float m = 1.0 - smoothstep(rad * 0.55, rad + px, dist);
        if (h2.y < 0.8) light = max(light, m);
        else dark = max(dark, m);
      }
    }
  d = mix(d, vec3(0.96, 0.95, 0.92), light * 0.85);
  d = mix(d, vec3(0.06), dark * 0.7);
  return d;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 iuv = imageUv();
  vec3 lin = texelFetch(uWork, p + uWorkPad, 0).rgb;

  // Global low-res layers (guided filter, glow) are sampled in image space.
  if (uLocalOn > 0.5) lin = localTone(lin, iuv, uRawExposure);
  else lin *= exp2(uRawExposure);
  if (uSharpen > 0.0) lin = sharpen(lin, p);
  // Camera RAW keeps channels above white for Highlights and Shadows to bring back; what is still above white
  // stops there, as the camera's own rendering does, so looks and effects see what they always saw. White is the
  // output's (clampWhite): a color beyond sRGB is not light above white.
  if (uClampWhite > 0.5) lin = clampWhite(lin, uOutP3 > 0.5, uSrgbToP3, uP3ToSrgb);

  if (uGlowOn > 0.5) {
    vec4 glow = texture(uGlow, iuv);
    if (uHalation > 0.0) {
      // Halation sits around highlights: subtract the core so hot areas do
      // not turn red, only their surroundings.
      float here = max(luma(lin) - 0.7, 0.0);
      float halo = max(glow.a * 1.4 - here * 0.3, 0.0);
      lin += uHalation * halo * vec3(1.0, 0.22, 0.06) * 1.3;
    }
    if (uBloom > 0.0) {
      lin += uBloom * glow.rgb * 1.3;
      // Diffusion veil: a whisper of the glow lifts nearby shadows.
      lin = mix(lin, lin + glow.rgb * 0.5, uBloom * 0.25);
    }
  }
  if (uLeak > 0.0) lin += lightLeak(iuv) * uLeak * 0.75;
  if (uVignette != 0.0) {
    float m = vignetteMask(iuv);
    lin *= exp2(-uVignette * 2.2 * m * m);
  }

  vec3 d;
  if (uOutP3 > 0.5) {
    // Looks are fitted in sRGB. A color beyond it (a component below 0, or above 1 where P3 still holds it) is pulled
    // toward its own luminance until it fits, the look acts on that, and the result is pushed back out by the same
    // factor: the look's saturation response carries on past sRGB, a B&W look stays gray, and an unedited color
    // comes back where it was. Light beyond P3's white (an effect or a lift pushed it there) is pulled in as far as
    // the P3 color it clips to, less and less up to three times white, where it renders as sRGB output does: the
    // look's shoulder takes it channel by channel. So nothing steps where a saturated color brightens past white.
    float Y = max(luma(lin), 0.0);
    vec3 p = uSrgbToP3 * lin;
    float beyond = max(max(p.r, p.g), p.b) - 1.0;
    vec3 g = lin;
    float Yg = Y;
    if (beyond > 0.0) {
      g = uP3ToSrgb * min(p, vec3(1.0));
      Yg = max(luma(g), 0.0);
    }
    float t = 1.0;
    // (Near white both sides of the ratio vanish, and so does the chroma it would scale.)
    for (int k = 0; k < 3; k++)
      if (g[k] > 1.0 && Yg < 1.0 && g[k] - Yg > 1e-4) t = min(t, (1.0 - Yg) / (g[k] - Yg));
    for (int k = 0; k < 3; k++)
      if (lin[k] < 0.0) t = min(t, Y / (Y - lin[k]));
    t = mix(max(t, 0.2), 1.0, smoothstep(0.0, 2.0, beyond));
    vec3 dl = srgbDecode(lutTetra(uLut, shaper(Y + t * (lin - Y))));
    if (t < 1.0) {
      float Yd = luma(dl);
      dl = Yd + (dl - Yd) / t;
    }
    // Display P3 shares sRGB's transfer curve.
    d = srgbEncode(clamp(uSrgbToP3 * dl, 0.0, 1.0));
  } else {
    d = lutTetra(uLut, shaper(lin));
  }

  if (uGrain > 0.0) d = grain(d);
  if (uDust > 0.0) d = dust(d);

  // Triangular dither of one output level before quantization kills banding.
  vec2 dp = imagePx();
  float n = hash12(dp) + hash12(dp + 101.3) - 1.0;
  d += n * uDither;
  outColor = vec4(clamp(d, 0.0, 1.0), 1.0);
}
