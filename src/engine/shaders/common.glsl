// Shared helpers. Prepended to every fragment shader after the #version line.

const float SHAPER_A = 64.0;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float PI = 3.14159265359;

vec3 srgbEncode(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 srgbDecode(vec3 c) {
  c = max(c, 0.0);
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
float srgbEncode1(float c) {
  c = max(c, 0.0);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}

// Linear 1.0 lands on lattice point 43 of 65 (see color.ts).
float shaperNorm() { return log2(SHAPER_A + 1.0) * 64.0 / 43.0; }
vec3 shaper(vec3 lin) { return log2(max(lin, 0.0) * SHAPER_A + 1.0) / shaperNorm(); }
vec3 shaperInv(vec3 s) { return (exp2(s * shaperNorm()) - 1.0) / SHAPER_A; }

// Light above white (camera RAW) stops at the output's white, each channel at 1 in the output's own primaries. In
// Display P3 a color beyond sRGB has a component above 1 in sRGB primaries without being brighter than white, so
// there the limit is P3's, where a P3 photo's own values stop; sRGB output keeps the sRGB limit.
vec3 clampWhite(vec3 lin, bool p3, mat3 toP3, mat3 fromP3) {
  if (!p3) return min(lin, vec3(1.0));
  vec3 c = toP3 * lin;
  return any(greaterThan(c, vec3(1.0))) ? fromP3 * min(c, vec3(1.0)) : lin;
}

vec3 cbrt3(vec3 v) { return sign(v) * pow(abs(v), vec3(1.0 / 3.0)); }

vec3 linToOklab(vec3 c) {
  vec3 lms = mat3(
    0.4122214708, 0.2119034982, 0.0883024619,
    0.5363325363, 0.6806995451, 0.2817188376,
    0.0514459929, 0.1073969566, 0.6299787005) * c;
  lms = cbrt3(lms);
  return mat3(
    0.2104542553, 1.9779984951, 0.0259040371,
    0.7936177850, -2.4285922050, 0.7827717662,
    -0.0040720468, 0.4505937099, -0.8086757660) * lms;
}
vec3 oklabToLin(vec3 c) {
  vec3 lms = mat3(
    1.0, 1.0, 1.0,
    0.3963377774, -0.1055613458, -0.0894841775,
    0.2158037573, -0.0638541728, -1.2914855480) * c;
  lms = lms * lms * lms;
  return mat3(
    4.0767416621, -1.2684380046, -0.0041960863,
    -3.3077115913, 2.6097574011, -0.7034186147,
    0.2309699292, -0.3413193965, 1.7076147010) * lms;
}

// Oklab hue centers (degrees) for the 8 selective-color bands.
const float BAND_HUE[8] = float[8](20.0, 55.0, 100.0, 140.0, 190.0, 250.0, 295.0, 340.0);

float hueDist(float a, float b) {
  float d = abs(a - b);
  return min(d, 360.0 - d);
}

// Partition-of-unity weights: each band fades to zero at its neighbours' centers.
void bandWeights(float hue, out float w[8]) {
  float total = 0.0;
  for (int i = 0; i < 8; i++) {
    int prev = (i + 7) % 8;
    int next = (i + 1) % 8;
    float span = hue - BAND_HUE[i];
    span = mod(span + 180.0, 360.0) - 180.0;
    float width = span < 0.0 ? hueDist(BAND_HUE[i], BAND_HUE[prev]) : hueDist(BAND_HUE[i], BAND_HUE[next]);
    float t = clamp(abs(span) / width, 0.0, 1.0);
    float v = 0.5 + 0.5 * cos(t * PI);
    w[i] = v;
    total += v;
  }
  for (int i = 0; i < 8; i++) w[i] /= max(total, 1e-5);
}

// Selective color in Oklab. h/s/l are -1..1 per band.
vec3 applyHsl(vec3 lab, float H[8], float S[8], float L[8]) {
  float C = length(lab.yz);
  if (C < 1e-5) return lab;
  float hue = degrees(atan(lab.z, lab.y));
  if (hue < 0.0) hue += 360.0;
  float w[8];
  bandWeights(hue, w);
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) {
    dh += w[i] * H[i];
    ds += w[i] * S[i];
    dl += w[i] * L[i];
  }
  // Colorfulness gate so near-neutrals are not touched.
  float gate = smoothstep(0.0, 0.06, C);
  hue += dh * 30.0 * gate;
  C *= max(0.0, 1.0 + ds * gate);
  lab.x += dl * 0.18 * gate * (1.0 - abs(lab.x - 0.5));
  float r = radians(hue);
  return vec3(lab.x, C * cos(r), C * sin(r));
}

// Tint shadows and highlights by adding chroma in Oklab (luminance preserved).
vec3 applySplit(vec3 lab, vec2 shadowAB, vec2 highAB, float balance) {
  float L = clamp(lab.x, 0.0, 1.0);
  float pivot = 0.55 + balance * 0.25;
  float sw = 1.0 - smoothstep(0.08, pivot + 0.1, L);
  float hw = smoothstep(pivot - 0.1, 0.98, L);
  lab.yz += shadowAB * sw + highAB * hw;
  return lab;
}

// Skin: rotate and saturate the orange band that holds skin tones.
vec3 applySkin(vec3 lab, float hueShift, float satShift) {
  float C = length(lab.yz);
  if (C < 1e-5) return lab;
  float hue = degrees(atan(lab.z, lab.y));
  float d = hueDist(hue < 0.0 ? hue + 360.0 : hue, 58.0);
  float w = exp(-d * d / (2.0 * 22.0 * 22.0));
  w *= smoothstep(0.02, 0.06, C) * (1.0 - smoothstep(0.2, 0.3, C));
  w *= smoothstep(0.25, 0.45, lab.x) * (1.0 - smoothstep(0.9, 1.0, lab.x));
  hue += hueShift * 14.0 * w;
  C *= 1.0 + satShift * 0.5 * w;
  float r = radians(hue);
  return vec3(lab.x, C * cos(r), C * sin(r));
}

// Tetrahedral interpolation into an N^3 LUT (4 texel fetches, no seams).
vec3 lutTetra(highp sampler3D lut, vec3 c) {
  float N = float(textureSize(lut, 0).x);
  vec3 p = clamp(c, 0.0, 1.0) * (N - 1.0);
  vec3 b = min(floor(p), vec3(N - 2.0));
  vec3 f = p - b;
  ivec3 i = ivec3(b);
  vec3 c000 = texelFetch(lut, i, 0).rgb;
  vec3 c111 = texelFetch(lut, i + ivec3(1), 0).rgb;
  vec3 r;
  if (f.r > f.g) {
    if (f.g > f.b) {
      vec3 c100 = texelFetch(lut, i + ivec3(1, 0, 0), 0).rgb;
      vec3 c110 = texelFetch(lut, i + ivec3(1, 1, 0), 0).rgb;
      r = c000 + f.r * (c100 - c000) + f.g * (c110 - c100) + f.b * (c111 - c110);
    } else if (f.r > f.b) {
      vec3 c100 = texelFetch(lut, i + ivec3(1, 0, 0), 0).rgb;
      vec3 c101 = texelFetch(lut, i + ivec3(1, 0, 1), 0).rgb;
      r = c000 + f.r * (c100 - c000) + f.b * (c101 - c100) + f.g * (c111 - c101);
    } else {
      vec3 c001 = texelFetch(lut, i + ivec3(0, 0, 1), 0).rgb;
      vec3 c101 = texelFetch(lut, i + ivec3(1, 0, 1), 0).rgb;
      r = c000 + f.b * (c001 - c000) + f.r * (c101 - c001) + f.g * (c111 - c101);
    }
  } else {
    if (f.b > f.g) {
      vec3 c001 = texelFetch(lut, i + ivec3(0, 0, 1), 0).rgb;
      vec3 c011 = texelFetch(lut, i + ivec3(0, 1, 1), 0).rgb;
      r = c000 + f.b * (c001 - c000) + f.g * (c011 - c001) + f.r * (c111 - c011);
    } else if (f.b > f.r) {
      vec3 c010 = texelFetch(lut, i + ivec3(0, 1, 0), 0).rgb;
      vec3 c011 = texelFetch(lut, i + ivec3(0, 1, 1), 0).rgb;
      r = c000 + f.g * (c010 - c000) + f.b * (c011 - c010) + f.r * (c111 - c011);
    } else {
      vec3 c010 = texelFetch(lut, i + ivec3(0, 1, 0), 0).rgb;
      vec3 c110 = texelFetch(lut, i + ivec3(1, 1, 0), 0).rgb;
      r = c000 + f.g * (c010 - c000) + f.r * (c110 - c010) + f.b * (c111 - c110);
    }
  }
  return r;
}

// Integer hash (pcg-ish) and gradient simplex noise in 3D.
uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 hash33(vec3 p) {
  uvec3 h = pcg3(uvec3(ivec3(floor(p)) + 32768));
  return vec3(h) * (1.0 / 4294967295.0);
}
float hash12(vec2 p) {
  uvec3 h = pcg3(uvec3(uvec2(ivec2(floor(p)) + 32768), 7u));
  return float(h.x) * (1.0 / 4294967295.0);
}

float simplex3(vec3 p) {
  const float F3 = 1.0 / 3.0;
  const float G3 = 1.0 / 6.0;
  vec3 s = floor(p + dot(p, vec3(F3)));
  vec3 x = p - s + dot(s, vec3(G3));
  vec3 e = step(vec3(0.0), x - x.yzx);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 x1 = x - i1 + G3;
  vec3 x2 = x - i2 + 2.0 * G3;
  vec3 x3 = x - 1.0 + 3.0 * G3;
  vec4 w = max(0.6 - vec4(dot(x, x), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 d = vec4(
    dot(hash33(s) - 0.5, x),
    dot(hash33(s + i1) - 0.5, x1),
    dot(hash33(s + i2) - 0.5, x2),
    dot(hash33(s + 1.0) - 0.5, x3));
  w *= w;
  w *= w;
  return dot(d * w, vec4(52.0)) * 1.4;
}
