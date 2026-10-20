// Guided filter, step 1: log2 luminance I and I^2 at reduced resolution.
// Sampling the mipmapped working texture picks the right LOD automatically.
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 outColor;
void main() {
  float y = dot(texture(uSrc, vUv).rgb, LUMA);
  float I = log2(y + 1.0 / 1024.0);
  outColor = vec4(I, I * I, 0.0, 1.0);
}
