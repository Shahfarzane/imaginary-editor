// Dual-filter upsample, accumulating the finer level with its own weight.
precision highp float;
uniform sampler2D uSrc;    // coarser accumulated level
uniform sampler2D uFine;   // this level's downsampled content
uniform vec2 uTexel;       // 1/size of the coarser level
uniform vec4 uWeight;      // weight of the fine level per channel
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 s = texture(uSrc, vUv + vec2(-2.0, 0.0) * uTexel);
  s += texture(uSrc, vUv + vec2(2.0, 0.0) * uTexel);
  s += texture(uSrc, vUv + vec2(0.0, -2.0) * uTexel);
  s += texture(uSrc, vUv + vec2(0.0, 2.0) * uTexel);
  s += texture(uSrc, vUv + vec2(-1.0, -1.0) * uTexel) * 2.0;
  s += texture(uSrc, vUv + vec2(1.0, -1.0) * uTexel) * 2.0;
  s += texture(uSrc, vUv + vec2(-1.0, 1.0) * uTexel) * 2.0;
  s += texture(uSrc, vUv + vec2(1.0, 1.0) * uTexel) * 2.0;
  outColor = s / 12.0 + texture(uFine, vUv) * uWeight;
}
