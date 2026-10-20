// Guided filter, step 2: linear coefficients a, b from the local moments.
precision highp float;
uniform sampler2D uMoments;  // mean I, mean I^2
uniform float uEps;
out vec4 outColor;
void main() {
  vec2 m = texelFetch(uMoments, ivec2(gl_FragCoord.xy), 0).rg;
  float v = max(m.y - m.x * m.x, 0.0);
  float a = v / (v + uEps);
  float b = m.x - a * m.x;
  outColor = vec4(a, b, 0.0, 1.0);
}
