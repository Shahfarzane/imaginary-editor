// Crop, rotate, straighten and flip the source into a linear-light working
// texture at output resolution. Chromatic aberration happens here because it
// is an optical, pre-film effect.
precision highp float;

uniform sampler2D uSource;   // SRGB8_ALPHA8, sampled values arrive linear
uniform mat3 uSourceToWork;  // the source's linear primaries -> linear sRGB (identity for sRGB sources)
uniform mat3 uXform;         // output uv -> source uv
uniform vec4 uSourceRect;    // uploaded region in full-source uv, xy origin and zw size
uniform float uAberration;   // 0..1
uniform vec2 uCenter;        // optical center in source uv

in vec2 vUv;
out vec4 outColor;

vec3 sampleSrc(vec2 uv, vec2 dx, vec2 dy) {
  // Outside the source: black (only visible if a crop is wrong).
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  vec2 p = (uv - uSourceRect.xy) / uSourceRect.zw;
  vec2 texels = vec2(textureSize(uSource, 0)) / uSourceRect.zw;
  // At native resolution, sample the original level. Tiny minification from rounded crop dimensions or
  // aberration must not blend differently phased mipmaps of independent source regions.
  if (max(length(dx * texels), length(dy * texels)) <= 1.01) return textureLod(uSource, p, 0.0).rgb;
  return textureGrad(uSource, p, dx / uSourceRect.zw, dy / uSourceRect.zw).rgb;
}

void main() {
  vec2 uv = (uXform * vec3(vUv, 1.0)).xy;
  // Derivatives are undefined inside the out-of-bounds branch above. Compute them for the whole quad first.
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  vec3 c;
  if (uAberration > 0.0) {
    // Lateral CA: red and blue magnify differently away from the optical axis.
    vec2 center = uCenter;
    vec2 d = uv - center;
    float k = uAberration * 0.006;
    float r = sampleSrc(center + d * (1.0 + k), dx * (1.0 + k), dy * (1.0 + k)).r;
    float g = sampleSrc(uv, dx, dy).g;
    float b = sampleSrc(center + d * (1.0 - k), dx * (1.0 - k), dy * (1.0 - k)).b;
    c = vec3(r, g, b);
  } else {
    c = sampleSrc(uv, dx, dy);
  }
  // Colors outside sRGB keep negative components here; the LUT's shaper clips them.
  outColor = vec4(uSourceToWork * c, 1.0);
}
