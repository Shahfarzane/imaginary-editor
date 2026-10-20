// Highlight extraction for halation (alpha, mono) and bloom (rgb).
precision highp float;
uniform sampler2D uSrc;
uniform float uHalThreshold;
uniform float uBloomThreshold;
uniform float uRawExposure;  // stops, as in the develop pass
uniform float uClampWhite;   // camera RAW: channels above white stop there, as in the develop pass
uniform float uOutP3;        // the output's white, as in the develop pass (clampWhite)
uniform mat3 uSrgbToP3;
uniform mat3 uP3ToSrgb;
in vec2 vUv;
out vec4 outColor;
float knee(float x, float t) {
  // Soft threshold: quadratic knee from t/2 to 3t/2, about 1.6 stops.
  float k = t * 0.5;
  float y = clamp(x - t + k, 0.0, 2.0 * k);
  y = y * y / (4.0 * k + 1e-5);
  return max(y, x - t);
}
void main() {
  vec3 c = texture(uSrc, vUv).rgb * exp2(uRawExposure);
  if (uClampWhite > 0.5) c = clampWhite(c, uOutP3 > 0.5, uSrgbToP3, uP3ToSrgb);
  float y = dot(c, LUMA);
  float hal = knee(y, uHalThreshold);
  float bl = knee(y, uBloomThreshold);
  vec3 bloom = c * (bl / max(y, 1e-4));
  outColor = vec4(bloom, hal);
}
