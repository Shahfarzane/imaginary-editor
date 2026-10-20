// Separable box blur of the RG channels (guided filter moments).
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uDir;     // (1,0) or (0,1)
uniform int uRadius;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 d = ivec2(uDir);
  vec2 acc = vec2(0.0);
  for (int i = -32; i <= 32; i++) {
    if (i < -uRadius || i > uRadius) continue;
    ivec2 q = clamp(p + d * i, ivec2(0), size - 1);
    acc += texelFetch(uSrc, q, 0).rg;
  }
  outColor = vec4(acc / float(2 * uRadius + 1), 0.0, 1.0);
}
