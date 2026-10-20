// Dual-filter (Kawase) downsample: 5 taps, smooth and cheap.
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uTexel;   // 1/size of the source level
in vec2 vUv;
out vec4 outColor;
void main() {
  vec4 s = texture(uSrc, vUv) * 4.0;
  s += texture(uSrc, vUv + vec2(-1.0, -1.0) * uTexel);
  s += texture(uSrc, vUv + vec2(1.0, -1.0) * uTexel);
  s += texture(uSrc, vUv + vec2(-1.0, 1.0) * uTexel);
  s += texture(uSrc, vUv + vec2(1.0, 1.0) * uTexel);
  outColor = s / 8.0;
}
