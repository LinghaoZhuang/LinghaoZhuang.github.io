/*
 * Linghao Zhuang — cinematic homepage, part 1: the renderer.
 *
 * A dependency-free WebGL2 pipeline:
 *   1. wall pass   — what the LED wall shows (rgb) and its relief height (a), mip-mapped
 *   2. scene pass  — an analytically ray-traced hall lit by the wall, with a silhouetted figure,
 *                    a relief-mapped wall, wet floor reflections, volumetric light and dust (HDR)
 *   3. bloom       — 13-tap downsample chain + tent upsample
 *   4. composite   — exposure, filmic curve, split-tone grade, vignette
 *   5. final       — FXAA and a fine, static dither against banding
 * The look is inspired by CineShader by Lusion (cineshader.com); all code here is original.
 */
(() => {
  'use strict';

  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const COMMON = `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm3(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s / 0.875;
}
float ridged(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { float n = 1.0 - abs(vnoise(p) * 2.0 - 1.0); s += a * n * n; p = p * 2.1 + vec2(3.1, 1.7); a *= 0.5; }
  return s / 0.9375;
}
`;

  /* ---------------------------------------------------------------- wall */
  const WALL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform float uTime;
uniform int uCur;
uniform int uPrev;
uniform float uMix;
uniform sampler2D uFigCur;
uniform sampler2D uFigPrev;
uniform float uAspCur;
uniform float uAspPrev;
uniform vec3 uPointer;
uniform float uPower;
const float ASPECT = 16.0 / 9.0;
${COMMON}

vec3 tintOf(int i) {
  if (i == 0) return vec3(0.78, 0.9, 1.0);
  if (i == 1) return vec3(1.0, 0.89, 0.78);
  if (i == 2) return vec3(0.8, 0.98, 0.9);
  if (i == 3) return vec3(0.91, 0.84, 1.0);
  if (i == 4) return vec3(1.0, 0.94, 0.85);
  return vec3(0.84, 0.94, 1.0);
}

// Reel 0 — Morphology: rounded cells packed like cobbles, each with a small lobed nucleus on its crown.
vec4 reelTissue(vec2 uv, float t) {
  vec2 p = (uv - 0.5) * vec2(ASPECT, 1.0) * 5.4;
  p += vec2(t * 0.03, t * 0.012);
  vec2 w = vec2(fbm3(p * 0.26 + vec2(0.0, t * 0.02)), fbm3(p * 0.26 + vec2(6.3, -t * 0.02))) - 0.5;
  p += w * 1.05;
  vec2 ip = floor(p), fp = fract(p);
  float sum = 0.0, d1 = 8.0, id = 0.0;
  vec2 r1 = vec2(0.0);
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash22(ip + g);
      o = 0.5 + 0.34 * sin(t * 0.22 + 6.2831 * o);
      vec2 r = g + o - fp;
      float d = dot(r, r);
      sum += exp(-9.0 * d);    // a smooth minimum: no creases inside a cell, soft valleys between cells
      if (d < d1) { d1 = d; r1 = r; id = hash21(ip + g); }
    }
  }
  float f = -log(max(sum, 1e-5)) / 9.0;
  float crown = 1.0 - clamp(f / 0.42, 0.0, 1.0);
  float lobes = floor(mix(2.0, 5.99, fract(id * 7.3)));
  float rn = mix(0.13, 0.2, id) * (1.0 + 0.2 * sin(lobes * atan(r1.y, r1.x) + id * 6.2831 + t * 0.15));
  float nucleus = exp(-d1 / (rn * rn));
  float h = 0.08 + 0.46 * crown * mix(0.8, 1.0, id) + 0.2 * nucleus;
  vec3 col = vec3(0.94, 0.955, 0.97) * (0.84 + 0.2 * h);
  col = mix(col, vec3(0.87, 0.88, 0.94), nucleus * 0.45);
  return vec4(col, clamp(h, 0.0, 1.0));
}

// Reel 1 — Gaussian field: thousands of anisotropic splats combed by a slow flow.
vec4 reelStrokes(vec2 uv, float t) {
  vec2 p = (uv - 0.5) * vec2(ASPECT, 1.0);
  float ang = 6.2831 * (fbm3(p * 1.4 + vec2(t * 0.04, -t * 0.025)) - 0.5) * 2.2;
  vec2 ax = vec2(cos(ang), sin(ang));
  vec2 ay = vec2(-ax.y, ax.x);
  float mask = smoothstep(0.2, 0.75, fbm3(p * 2.3 + vec2(-t * 0.03, t * 0.02) + 4.0));
  const float S = 24.0;
  vec2 g = p * S;
  vec2 ig = floor(g);
  float h = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = ig + vec2(float(i), float(j));
      vec2 rnd = hash22(cell);
      vec2 c = cell + 0.5 + (rnd - 0.5) * 0.6 + ax * sin(t * 0.3 + rnd.x * 6.28) * 0.1;
      vec2 d = g - c;
      float u = dot(d, ax) / mix(0.48, 0.74, rnd.x);
      float v = dot(d, ay) / mix(0.1, 0.18, rnd.y);
      h = max(h, exp(-(u * u + v * v)) * mix(0.55, 1.0, rnd.y));
    }
  }
  h = 0.12 + h * (0.25 + 0.55 * mask);
  vec3 col = vec3(0.95, 0.96, 0.97) * (0.82 + 0.22 * h);
  return vec4(col, clamp(h, 0.0, 1.0));
}

// Reel 2 — Federation: six clients send ripples that interfere; the server answers with a ring.
vec4 reelWaves(vec2 uv, float t) {
  vec2 p = (uv - 0.5) * vec2(ASPECT, 1.0);
  float wv = 0.0;
  vec3 tint = vec3(0.0);
  float tw = 0.0;
  for (int i = 0; i < 6; i++) {
    float fi = float(i);
    float a = 6.2831853 * fi / 6.0 + 0.5;
    vec2 c = vec2(cos(a) * 0.6, sin(a) * 0.32);
    float d = length(p - c);
    wv += sin(d * 64.0 - t * 2.2 + hash11(fi * 3.7) * 6.2831) * exp(-d * 1.8);
    float wt = exp(-d * 9.0);
    tint += wt * tintOf(i);
    tw += wt;
    wv += exp(-d * d / 0.0009) * 2.2;
  }
  float cyc = fract(t / 4.8);
  float ds = length(p);
  float ring = exp(-pow((ds - cyc * 1.15) / 0.03, 2.0)) * (1.0 - cyc);
  float server = exp(-ds * ds / 0.0016);
  float h = 0.36 + wv * 0.085 + ring * 0.3 + server * (0.3 + 0.15 * exp(-pow((cyc - 0.02) / 0.05, 2.0)));
  vec3 col = vec3(0.94, 0.955, 0.97) * (0.84 + 0.22 * h);
  col = mix(col, tint / max(tw, 1e-3), clamp(tw * 0.45, 0.0, 0.35));
  return vec4(col, clamp(h, 0.0, 1.0));
}

// A paper figure, contained on a white slide. Flat: height 0.
vec4 slide(sampler2D tex, float asp, vec2 uv) {
  vec2 box = vec2(0.9, 0.84);
  vec2 size = vec2(box.x, box.x * ASPECT / asp);
  if (size.y > box.y) size = vec2(box.y * asp / ASPECT, box.y);
  vec2 iuv = (uv - (0.5 - 0.5 * size)) / size;
  vec3 img = texture(tex, vec2(iuv.x, 1.0 - iuv.y)).rgb;
  vec2 in2 = step(vec2(0.0), iuv) * step(iuv, vec2(1.0));
  return vec4(mix(vec3(0.955, 0.962, 0.966), img, in2.x * in2.y), 0.0);
}

vec4 source(int id, vec2 uv, float t) {
  if (id == 0) return reelTissue(uv, t);
  if (id == 1) return reelStrokes(uv, t);
  if (id == 2) return reelWaves(uv, t);
  if (id == 3) return slide(uFigCur, uAspCur, uv);
  return slide(uFigPrev, uAspPrev, uv);
}

// A soft swell that follows the pointer across the relief.
float pointerField(vec2 uv) {
  vec2 d = (uv - uPointer.xy) * vec2(ASPECT, 1.0);
  return uPointer.z * exp(-dot(d, d) / 0.02);
}

void main() {
  vec2 uv = vUv;
  vec4 c = source(uCur, uv, uTime);
  float reel = uCur < 3 ? 1.0 : 0.0;
  if (uMix < 1.0) {
    vec4 prv = source(uPrev, uv, uTime);
    float s = uv.x * 0.84 + (1.0 - uv.y) * 0.16 + (vnoise(uv * vec2(7.0, 31.0) + uTime * 0.5) - 0.5) * 0.09;
    float front = mix(-0.14, 1.14, uMix);
    float behind = smoothstep(front - 0.02, front + 0.02, s);
    c = mix(c, prv, behind);
    reel = mix(reel, uPrev < 3 ? 1.0 : 0.0, behind);
    float band = exp(-pow((s - front) / 0.045, 2.0));
    c.a = max(c.a, band * (0.5 + 0.5 * vnoise(uv * vec2(46.0, 80.0) + uTime * 0.4)) * 0.8);
    c.rgb = mix(c.rgb, vec3(0.94, 0.99, 1.0), band * 0.6);
  }
  vec2 rim = min(uv, 1.0 - uv) * vec2(ASPECT, 1.0);
  c.a *= smoothstep(0.0, 0.05, min(rim.x, rim.y));
  if (uPointer.z > 0.001) {
    float pf = pointerField(uv) * reel;
    c.a = clamp(c.a + pf * 0.32, 0.0, 1.0);
    c.rgb = min(c.rgb + pf * 0.03, vec3(1.0));
  }
  if (uPower < 1.0) {
    // power: a bright line opens vertically into the picture, and closes the same way
    float open = smoothstep(0.06, 1.0, uPower) * 0.56;
    float dist = abs(uv.y - 0.5);
    float vis = step(0.06, uPower) * (1.0 - smoothstep(open, open + 0.015, dist));
    float line = exp(-pow(dist / (0.004 + open * 0.05), 2.0)) * (1.0 - uPower) * smoothstep(0.0, 0.06, uPower);
    c.rgb = c.rgb * vis + vec3(line * 1.4);
    c.a *= vis;
  }
  outColor = vec4(clamp(c.rgb, 0.0, 1.0), clamp(c.a, 0.0, 1.0));
}`;

  /* --------------------------------------------------------------- scene */
  const SCENE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uCamPos;
uniform vec3 uCamTarget;
uniform float uFov;
uniform float uRoll;
uniform sampler2D uScreen;
uniform vec2 uTexel;
uniform float uRelief;
uniform float uGain;
uniform float uWallGain;
uniform float uSteps;
uniform float uVolSteps;
uniform vec4 uFig;       // x, z, yaw, visible
uniform float uBeam;
uniform float uHdrScale;

#define PI 3.14159265
const vec2 SC = vec2(0.0, 2.445);   // wall centre (x, y); its face is the plane z = 0
const vec2 SH = vec2(3.6, 2.025);   // half size of the 16:9 image area
const float BEZ = 0.13;
const float PANEL_D = 0.5;
const float BACK_Z = -6.5;
const float SIDE_X = 13.0;
const float CEIL_Y = 13.5;

#define M_NONE 0
#define M_FLOOR 1
#define M_WALL 2
#define M_CEIL 3
#define M_FRAME 4
#define M_STEEL 5
#define M_FIG 6

${COMMON}

vec3 toLin(vec3 c) { return c * c; }
vec3 scr(vec2 uv, float lod) { return toLin(textureLod(uScreen, uv, lod).rgb); }
vec3 gAvg;   // the wall's average colour, fetched once per pixel
float wallH(vec2 uv, float lod) {
  vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
  return textureLod(uScreen, clamp(uv, 0.0, 1.0), lod).a * inb.x * inb.y;
}

struct Hit { float t; vec3 n; int m; };

void iPlane(vec3 ro, vec3 rd, vec3 n, float d, int m, inout Hit h) {
  float den = dot(n, rd);
  if (den < -1e-5) {
    float t = -(dot(n, ro) + d) / den;
    if (t > 1e-3 && t < h.t) { h.t = t; h.n = n; h.m = m; }
  }
}
void iBox(vec3 ro, vec3 rd, vec3 c, vec3 b, int m, inout Hit h) {
  vec3 inv = 1.0 / (rd + 1e-7 * step(abs(rd), vec3(1e-7)));
  vec3 n = inv * (ro - c);
  vec3 k = abs(inv) * b;
  vec3 t1 = -n - k;
  vec3 t2 = -n + k;
  float tN = max(max(t1.x, t1.y), t1.z);
  float tF = min(min(t2.x, t2.y), t2.z);
  if (tN > tF || tN < 1e-3 || tN >= h.t) return;
  h.t = tN;
  h.n = -sign(rd) * step(t1.yzx, t1.xyz) * step(t1.zxy, t1.xyz);
  h.m = m;
}
Hit trace(vec3 ro, vec3 rd) {
  Hit h;
  h.t = 1e4; h.n = vec3(0.0, 1.0, 0.0); h.m = M_NONE;
  iPlane(ro, rd, vec3(0.0, 1.0, 0.0), 0.0, M_FLOOR, h);
  iPlane(ro, rd, vec3(0.0, -1.0, 0.0), CEIL_Y, M_CEIL, h);
  iPlane(ro, rd, vec3(0.0, 0.0, 1.0), -BACK_Z, M_WALL, h);
  iPlane(ro, rd, vec3(0.0, 0.0, -1.0), 34.0, M_WALL, h);
  iPlane(ro, rd, vec3(1.0, 0.0, 0.0), SIDE_X, M_WALL, h);
  iPlane(ro, rd, vec3(-1.0, 0.0, 0.0), SIDE_X, M_WALL, h);
  float cabTop = SC.y + SH.y + BEZ;
  iBox(ro, rd, vec3(SC.x, cabTop * 0.5, -PANEL_D * 0.5), vec3(SH.x + BEZ, cabTop * 0.5, PANEL_D * 0.5), M_FRAME, h);
  for (int i = 0; i < 3; i++) {
    float z = -2.5 + float(i) * 8.0;
    iBox(ro, rd, vec3(-SIDE_X + 0.32, CEIL_Y * 0.5, z), vec3(0.32, CEIL_Y * 0.5, 0.36), M_STEEL, h);
    iBox(ro, rd, vec3(SIDE_X - 0.32, CEIL_Y * 0.5, z), vec3(0.32, CEIL_Y * 0.5, 0.36), M_STEEL, h);
    if (rd.y > 0.0) iBox(ro, rd, vec3(0.0, CEIL_Y - 0.75, z), vec3(SIDE_X, 0.3, 0.2), M_STEEL, h);
  }
  return h;
}

/* --- the figure: a person in a long coat, hands in pockets, facing the wall --- */
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) { vec3 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h) - r; }
float sdEllipsoid(vec3 p, vec3 r) { float k0 = length(p / r); float k1 = length(p / (r * r)); return k0 * (k0 - 1.0) / k1; }
float sdRoundCone(vec3 p, vec3 a, vec3 b, float r1, float r2) {
  vec3 ba = b - a;
  float l2 = dot(ba, ba);
  float rr = r1 - r2;
  float a2 = l2 - rr * rr;
  float il2 = 1.0 / l2;
  vec3 pa = p - a;
  float y = dot(pa, ba);
  float z = y - l2;
  vec3 xv = pa * l2 - ba * y;
  float x2 = dot(xv, xv);
  float y2 = y * y * l2;
  float z2 = z * z * l2;
  float k = sign(rr) * rr * rr * x2;
  if (sign(z) * a2 * z2 > k) return sqrt(x2 + z2) * il2 - r2;
  if (sign(y) * a2 * y2 < k) return sqrt(x2 + y2) * il2 - r1;
  return (sqrt(x2 * a2 * il2) + y * rr) * il2 - r1;
}
float sdFigure(vec3 p) {
  float d = sdEllipsoid(p - vec3(0.0, 1.615, 0.0), vec3(0.092, 0.112, 0.102));
  d = smin(d, sdEllipsoid(p - vec3(0.0, 1.648, 0.018), vec3(0.103, 0.1, 0.108)), 0.03);
  d = smin(d, sdCapsule(p, vec3(0.0, 1.44, 0.012), vec3(0.0, 1.55, 0.0), 0.047), 0.035);
  vec3 q = p;
  q.x *= 0.82;
  q.z *= 1.35;
  d = smin(d, sdRoundCone(q, vec3(0.0, 1.36, 0.0), vec3(0.0, 0.5, 0.0), 0.15, 0.2) / 1.35, 0.06);
  d = smin(d, sdCapsule(p, vec3(-0.17, 1.39, 0.0), vec3(0.17, 1.39, 0.0), 0.062), 0.06);
  d = smin(d, sdCapsule(p, vec3(-0.215, 1.37, 0.0), vec3(-0.24, 1.07, 0.02), 0.05), 0.03);
  d = smin(d, sdCapsule(p, vec3(-0.24, 1.07, 0.02), vec3(-0.2, 0.86, -0.04), 0.045), 0.03);
  d = smin(d, sdCapsule(p, vec3(0.215, 1.37, 0.0), vec3(0.24, 1.07, 0.02), 0.05), 0.03);
  d = smin(d, sdCapsule(p, vec3(0.24, 1.07, 0.02), vec3(0.2, 0.86, -0.04), 0.045), 0.03);
  d = smin(d, sdCapsule(p, vec3(-0.09, 0.62, 0.0), vec3(-0.1, 0.07, 0.01), 0.058), 0.02);
  d = smin(d, sdCapsule(p, vec3(0.09, 0.62, 0.0), vec3(0.13, 0.07, 0.05), 0.056), 0.02);
  d = smin(d, sdEllipsoid(p - vec3(-0.1, 0.04, -0.05), vec3(0.05, 0.04, 0.12)), 0.02);
  d = smin(d, sdEllipsoid(p - vec3(0.135, 0.04, -0.01), vec3(0.05, 0.04, 0.12)), 0.02);
  return d;
}
vec3 toFig(vec3 p) { vec3 q = p - vec3(uFig.x, 0.0, uFig.y); float c = cos(uFig.z), s = sin(uFig.z); return vec3(c * q.x - s * q.z, q.y, s * q.x + c * q.z); }
vec3 dirToFig(vec3 d) { float c = cos(uFig.z), s = sin(uFig.z); return vec3(c * d.x - s * d.z, d.y, s * d.x + c * d.z); }
vec3 dirFromFig(vec3 d) { float c = cos(uFig.z), s = sin(uFig.z); return vec3(c * d.x + s * d.z, d.y, -s * d.x + c * d.z); }
vec2 boxRange(vec3 o, vec3 d, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / (d + 1e-7 * step(abs(d), vec3(1e-7)));
  vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv;
  vec3 a = min(t0, t1), b = max(t0, t1);
  return vec2(max(max(a.x, a.y), a.z), min(min(b.x, b.y), b.z));
}
bool traceFigure(vec3 ro, vec3 rd, float tMax, int steps, out float tHit, out vec3 nW) {
  tHit = 0.0;
  nW = vec3(0.0, 0.0, 1.0);
  if (uFig.w < 0.5) return false;
  vec3 o = toFig(ro), d = dirToFig(rd);
  vec2 tb = boxRange(o, d, vec3(-0.42, 0.0, -0.32), vec3(0.42, 1.8, 0.32));
  if (tb.x > tb.y || tb.y < 0.0 || tb.x > tMax) return false;
  float t = max(tb.x, 0.0);
  float tEnd = min(tb.y, tMax);
  for (int i = 0; i < 64; i++) {
    if (i >= steps) break;
    float h = sdFigure(o + d * t);
    if (h < 0.0012) {
      vec3 p = o + d * t;
      const vec2 k = vec2(1.0, -1.0);
      const float e = 0.002;
      vec3 n = normalize(k.xyy * sdFigure(p + k.xyy * e) + k.yyx * sdFigure(p + k.yyx * e) + k.yxy * sdFigure(p + k.yxy * e) + k.xxx * sdFigure(p + k.xxx * e));
      nW = dirFromFig(n);
      tHit = t;
      return true;
    }
    t += h;
    if (t > tEnd) break;
  }
  return false;
}
// Three capsules stand in for the figure when only its shadow matters.
float segDist(vec3 p1, vec3 q1, vec3 p2, vec3 q2) {
  vec3 d1 = q1 - p1, d2 = q2 - p2, r = p1 - p2;
  float a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2);
  float den = a * e - b * b;
  float s = den > 1e-6 ? clamp((b * f - c * e) / den, 0.0, 1.0) : 0.0;
  float t = (b * s + f) / max(e, 1e-6);
  if (t < 0.0) { t = 0.0; s = clamp(-c / a, 0.0, 1.0); }
  else if (t > 1.0) { t = 1.0; s = clamp((b - c) / a, 0.0, 1.0); }
  return length((p1 + d1 * s) - (p2 + d2 * t));
}
float figOcclusion(vec3 P, vec3 L) {
  vec3 f = vec3(uFig.x, 0.0, uFig.y);
  float pen = 0.05 + 0.1 * length(P.xz - f.xz);
  float d1 = segDist(P, L, f + vec3(0.0, 0.5, 0.0), f + vec3(0.0, 1.42, 0.0)) - 0.2;
  float d2 = segDist(P, L, f + vec3(0.0, 1.62, 0.0), f + vec3(0.0, 1.62, 0.0)) - 0.12;
  float d3 = segDist(P, L, f + vec3(0.0, 0.05, 0.0), f + vec3(0.0, 0.55, 0.0)) - 0.13;
  return smoothstep(-pen, pen, min(d1, min(d2, d3)));
}
float floorShadow(vec3 P) {
  if (uFig.w < 0.5 || P.z < uFig.y - 0.6 || P.z > uFig.y + 10.0 || abs(P.x - uFig.x) > 6.5) return 1.0;
  float s = 0.0;
  for (int i = 0; i < 3; i++) s += figOcclusion(P, vec3(SC.x + (float(i) - 1.0) * SH.x * 0.66, SC.y, 0.0));
  return s / 3.0;
}
float sdSeg2(vec2 p, vec2 a, vec2 b) { vec2 pa = p - a, ba = b - a; return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0)); }
float beamVis(vec3 q) {
  if (uFig.w < 0.5 || q.z < uFig.y) return 1.0;
  vec2 f = q.xy - vec2(uFig.x, 0.0);
  float dz = q.z - uFig.y;
  float pen = 0.03 + 0.1 * dz;
  if (abs(f.x) > 0.3 + pen) return 1.0;
  float d = min(min(length(f - vec2(0.0, 1.62)) - 0.12, sdSeg2(f, vec2(0.0, 0.5), vec2(0.0, 1.42)) - 0.2), sdSeg2(f, vec2(0.0, 0.05), vec2(0.0, 0.55)) - 0.13);
  return mix(1.0, smoothstep(-pen, pen, d), exp(-dz * 0.14));
}

/* --- light from the wall --- */
vec3 areaLight(vec3 P, vec3 N) {
  vec3 sum = vec3(0.0);
  const float AREA = (2.0 * SH.x / 2.0) * (2.0 * SH.y / 2.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      vec2 uvp = vec2((float(i) + 0.5) * 0.5, (float(j) + 0.5) * 0.5);
      vec3 d = vec3(SC + (uvp * 2.0 - 1.0) * SH, 0.2 * uRelief) - P;
      float r2 = dot(d, d);
      vec3 l = d * inversesqrt(r2);
      sum += scr(uvp, 8.6) * (max(dot(N, l), 0.0) * max(-l.z, 0.0) * AREA / (PI * r2 + AREA));
    }
  }
  return sum * uGain;
}
vec3 bounce(vec3 P, vec3 N) {
  vec3 d = P - vec3(SC, 3.0);
  return gAvg * uGain * (0.08 / (1.0 + 0.012 * dot(d, d))) * (0.7 + 0.3 * N.y) + vec3(0.0007, 0.0012, 0.0014);
}

vec2 wallUV(vec3 P, vec3 N) { return abs(N.x) > 0.5 ? P.zy : P.xy; }
vec3 wallAlbedo(vec3 P, vec3 N) {
  vec2 w = wallUV(P, N);
  float v = hash21(vec2(floor(w.y / 1.45), floor(w.x / 2.9)) + N.xz * 13.0);
  float grime = vnoise(w * vec2(0.3, 0.9) + N.xz * 7.0);
  float fy = fract(w.y / 1.45), fx = fract(w.x / 2.9);
  float seam = smoothstep(0.0, 0.02, fy) * (1.0 - smoothstep(0.975, 1.0, fy)) * smoothstep(0.0, 0.006, fx) * (1.0 - smoothstep(0.994, 1.0, fx));
  vec3 base = vec3(0.44, 0.46, 0.47) * (0.8 + 0.32 * v) * (0.68 + 0.45 * grime);
  base *= mix(0.5, 1.0, smoothstep(0.0, 1.2, P.y));
  if (abs(N.x) > 0.5) {
    for (int i = 0; i < 2; i++) {
      vec2 o = w - vec2(1.5 + float(i) * 8.0, 6.3);
      if (abs(o.x) < 4.0) {
        vec2 a = vec2(abs(o.x * 0.8165 + o.y * 0.5774), abs(o.x * 0.8165 - o.y * 0.5774));
        base *= mix(0.25, 1.0, smoothstep(0.1, 0.17, min(a.x, a.y)));
      }
    }
  }
  return base * mix(0.3, 1.0, seam);
}
vec3 wallNormal(vec3 P, vec3 N) {
  float fy = fract(wallUV(P, N).y / 1.45);
  float tilt = smoothstep(0.86, 1.0, fy) * 0.55 - (1.0 - smoothstep(0.0, 0.1, fy)) * 0.45;
  return normalize(N + vec3(0.0, tilt, 0.0));
}
vec3 shadeSurface(vec3 P, vec3 N, int m, vec3 rd) {
  vec3 alb = vec3(0.6, 0.62, 0.63);
  vec3 n = N;
  float sheen = 0.1;
  if (m == M_WALL) { n = wallNormal(P, N); alb = wallAlbedo(P, N); sheen = 0.08; }
  else if (m == M_CEIL) { alb = vec3(0.05); sheen = 0.0; }
  else if (m == M_STEEL) { alb = vec3(0.16, 0.17, 0.175); sheen = 0.14; }
  else if (m == M_FRAME) { alb = vec3(0.03, 0.032, 0.034); sheen = 0.02; }
  vec3 col = alb * (areaLight(P, n) + bounce(P, n));
  if (sheen > 0.0) {
    vec3 l = normalize(vec3(SC, 0.3) - P);
    float sp = pow(max(dot(n, normalize(l - rd)), 0.0), 18.0) * max(-l.z, 0.0);
    col += gAvg * uGain * sp * sheen;
  }
  if (m == M_FRAME && N.z > 0.5) {
    vec2 dd = abs(P.xy - SC) - SH;
    col += gAvg * uGain * (0.002 + 0.06 * exp(-max(max(dd.x, dd.y), 0.0) * 14.0));
  }
  return col;
}
vec3 shadeFigure(vec3 P, vec3 n, vec3 rd) {
  vec3 col = vec3(0.026, 0.028, 0.03) * (areaLight(P, n) + bounce(P, n) * 0.6);
  float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0) * smoothstep(-0.2, 0.7, -n.z);
  return col + gAvg * uGain * rim * 0.16;
}

vec3 reflectTrace(vec3 ro, vec3 rd, float rough) {
  float tW = (rd.z < -1e-4 && ro.z > 0.0) ? -ro.z / rd.z : 1e4;
  float tF;
  vec3 nF;
  if (traceFigure(ro, rd, min(tW, 40.0), 16, tF, nF)) return shadeFigure(ro + rd * tF, nF, rd) * exp(-0.012 * tF);
  vec3 col = gAvg * uGain * 0.006;
  if (tW < 1e3) {
    vec2 Pw = (ro + rd * tW).xy;
    vec2 q = abs(Pw - SC) - SH;
    float lod = clamp(log2(1.0 + tW * rough * 70.0), 0.0, 8.0);
    float blur = exp2(lod) / 720.0;
    float bw = max(blur * 5.0 * SH.y, 0.05);
    float cov = 1.0 - smoothstep(-bw, bw, max(q.x, q.y));
    if (cov > 0.001) {
      vec2 uv = (Pw - (SC - SH)) / (2.0 * SH);
      vec2 off = vec2(0.0, blur * 1.6);
      vec3 e = scr(uv, lod) * 0.5 + (scr(uv + off, lod) + scr(uv - off, lod)) * 0.25;
      col = mix(col, e * uWallGain, cov);
    }
  }
  return col * exp(-0.012 * min(tW, 80.0));
}
vec3 shadeFloor(vec3 P, vec3 rd) {
  float wet = smoothstep(0.32, 0.6, 0.62 * vnoise(P.xz * 0.1 + 3.7) + 0.38 * vnoise(P.xz * 0.23 + 9.1));
  float rough = mix(0.22, 0.02, wet);
  vec2 g = vec2(vnoise(P.xz * 2.1), vnoise(P.xz * 2.1 + 9.0)) - 0.5;
  float bump = 0.045 * (1.0 - 0.8 * wet);
  vec3 N = normalize(vec3(g.x * bump, 1.0, g.y * bump));
  vec3 alb = vec3(0.06, 0.066, 0.07) * (0.85 + 0.3 * wet);
  vec3 diff = alb * (areaLight(P, N) * floorShadow(P) + bounce(P, N));
  float F = 0.03 + 0.97 * pow(1.0 - max(dot(N, -rd), 0.0), 5.0);
  vec3 refl = reflectTrace(P + N * 0.003, reflect(rd, N), rough);
  return diff + refl * F * mix(0.55, 1.0, wet) * (0.6 + 0.4 * exp(-max(P.z, 0.0) * 0.06));
}

/* --- the relief: the wall image extruded toward the viewer by uRelief metres --- */
bool reliefMarch(vec3 ro, vec3 rd, float tMax, out float tHit, out vec2 uvHit) {
  tHit = 0.0;
  uvHit = vec2(0.0);
  if (uRelief < 0.01 || rd.z > -1e-4) return false;
  float tA = max((uRelief - ro.z) / rd.z, 0.0);
  float tB = min(-ro.z / rd.z, tMax);
  if (tA >= tB) return false;
  vec2 lo = SC - SH, sz = 2.0 * SH;
  vec2 pa = (ro + rd * tA).xy, pb = (ro + rd * tB).xy;
  vec2 mn = min(pa, pb), mx = max(pa, pb);
  if (mx.x < lo.x || mn.x > lo.x + sz.x || mx.y < lo.y || mn.y > lo.y + sz.y) return false;
  float n = clamp((tB - tA) / 0.065, 8.0, uSteps);
  float dt = (tB - tA) / n;
  float t = tA, pt = tA;
  for (int i = 0; i < 80; i++) {
    if (float(i) >= n) break;
    t += dt;
    vec3 p = ro + rd * t;
    if (p.z <= wallH((p.xy - lo) / sz, 0.6) * uRelief) {
      float a = pt, b = t;
      for (int k = 0; k < 4; k++) {
        float m = 0.5 * (a + b);
        vec3 qp = ro + rd * m;
        if (qp.z <= wallH((qp.xy - lo) / sz, 0.6) * uRelief) b = m; else a = m;
      }
      tHit = b;
      uvHit = ((ro + rd * b).xy - lo) / sz;
      return uvHit.x >= 0.0 && uvHit.x <= 1.0 && uvHit.y >= 0.0 && uvHit.y <= 1.0;
    }
    pt = t;
  }
  return false;
}
vec3 reliefShade(vec2 uv, vec3 P, vec3 rd, vec2 gx, vec2 gy) {
  vec2 e = uTexel * 1.5;
  float hc = wallH(uv, 0.6);
  float dzdx = (wallH(uv + vec2(e.x, 0.0), 0.6) - wallH(uv - vec2(e.x, 0.0), 0.6)) * uRelief / (2.0 * e.x * 2.0 * SH.x);
  float dzdy = (wallH(uv + vec2(0.0, e.y), 0.6) - wallH(uv - vec2(0.0, e.y), 0.6)) * uRelief / (2.0 * e.y * 2.0 * SH.y);
  vec3 n = normalize(vec3(-dzdx, -dzdy, 1.0));
  vec3 L = normalize(vec3(-0.55, 0.6, 0.6));
  vec2 lo = SC - SH, sz = 2.0 * SH;
  float sh = 1.0;
  for (int i = 1; i <= 4; i++) {
    float d = float(i) * 0.125;
    vec3 q = P + L * d;
    sh = min(sh, clamp((q.z - wallH((q.xy - lo) / sz, 1.9 + float(i) * 0.8) * uRelief) / (d * 0.42) + 0.2, 0.0, 1.0));
  }
  float lam = max(dot(n, L), 0.0) / L.z;
  float ao = clamp(1.0 - (wallH(uv, 4.5) - hc) * 3.0, 0.25, 1.0);
  float shade = (0.34 + 0.66 * lam * sh) * ao + pow(1.0 - max(dot(n, -rd), 0.0), 4.0) * 0.15;
  return toLin(textureGrad(uScreen, uv, gx, gy).rgb) * shade * uWallGain;
}

/* --- air: light shafts in front of the wall, with the figure's shadow, and drifting dust --- */
vec3 beams(vec3 ro, vec3 rd, float T, float jit) {
  vec2 tb = boxRange(ro, rd, vec3(-SH.x - 1.6, 0.0, 0.0), vec3(SH.x + 1.6, SC.y + SH.y + 1.2, 12.0));
  float t0 = max(tb.x, 0.0), t1 = min(tb.y, T);
  if (t1 <= t0) return vec3(0.0);
  float dt = (t1 - t0) / uVolSteps;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 32; i++) {
    if (float(i) >= uVolSteps) break;
    vec3 q = ro + rd * (t0 + (float(i) + jit) * dt);
    float z = max(q.z, 0.0);
    vec2 uv = (q.xy - (SC - SH)) / (2.0 * SH);
    float spread = 0.03 + z * 0.045;
    vec2 m2 = smoothstep(vec2(-spread), vec2(spread), 0.5 - abs(uv - 0.5));
    float mask = m2.x * m2.y;
    if (mask < 0.002) continue;
    vec3 Le = scr(clamp(uv, 0.0, 1.0), 5.5 + min(z * 0.35, 3.0));
    float dens = 0.25 + 1.1 * exp(-q.y * 0.85);
    acc += Le * (mask * dens * beamVis(q) / (1.0 + 0.11 * z * z));
  }
  return acc * dt * uGain * (0.55 + 1.4 * pow(max(-rd.z, 0.0), 3.0)) * 0.06;
}
vec3 motes(vec3 ro, vec3 rd, float T) {
  if (abs(rd.z) < 1e-3) return vec3(0.0);
  vec3 acc = vec3(0.0);
  for (int k = 0; k < 3; k++) {
    float fk = float(k);
    float zk = 1.2 + fk * 3.3;
    float t = (zk - ro.z) / rd.z;
    if (t <= 0.05 || t >= T) continue;
    vec3 q = ro + rd * t;
    vec2 g = (q.xy + vec2(sin(uTime * 0.07 + fk) * 0.3, -uTime * (0.025 + 0.01 * fk))) / 0.36;
    vec2 ic = floor(g), fc = fract(g);
    vec2 r = hash22(ic + fk * 17.0);
    vec2 mpos = 0.25 + 0.5 * r + 0.05 * vec2(sin(uTime * 0.2 + r.x * 40.0), cos(uTime * 0.17 + r.y * 40.0));
    float d = length(fc - mpos) * 0.36;
    float size = max(0.004 + 0.007 * hash21(ic + 3.0), t * 0.0011);
    float glow = exp(-d * d / (size * size)) * step(0.74, hash21(ic + fk));
    vec2 uv = (q.xy - (SC - SH)) / (2.0 * SH);
    float z = max(q.z, 0.0);
    vec2 m2 = smoothstep(vec2(-0.1 - z * 0.05), vec2(0.1 + z * 0.05), 0.5 - abs(uv - 0.5));
    acc += gAvg * glow * exp(-t * 0.07) * (m2.x * m2.y / (1.0 + 0.08 * z * z)) * (0.7 + 0.3 * sin(uTime * 0.4 + r.y * 30.0));
  }
  return acc * uGain * 0.6;
}

void main() {
  gAvg = scr(vec2(0.5), 12.0);
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 ro = uCamPos;
  vec3 fw = normalize(uCamTarget - uCamPos);
  vec3 rt = normalize(cross(fw, vec3(sin(uRoll), cos(uRoll), 0.0)));
  vec3 up = cross(rt, fw);
  float tf = tan(uFov * 0.5);
  vec3 rd = normalize(fw + rt * (ndc.x * tf * uRes.x / uRes.y) + up * (ndc.y * tf));

  // wall-plane uv and its derivatives, taken in uniform control flow for filtered sampling
  float tp = rd.z < -1e-4 ? -ro.z / rd.z : 1e4;
  vec2 uvPlane = ((ro + rd * tp).xy - (SC - SH)) / (2.0 * SH);
  vec2 gx = dFdx(uvPlane), gy = dFdy(uvPlane);

  Hit h = trace(ro, rd);
  float tF;
  vec3 nF;
  bool fig = traceFigure(ro, rd, h.t, 56, tF, nF);
  if (fig) { h.t = tF; h.n = nF; h.m = M_FIG; }
  float tR;
  vec2 uvR;
  float onScreen = 0.0;
  vec3 col;
  if (!fig && reliefMarch(ro, rd, h.t, tR, uvR)) {
    col = reliefShade(uvR, ro + rd * tR, rd, gx, gy);
    h.t = tR;
    onScreen = 1.0;
  } else {
    vec3 P = ro + rd * h.t;
    vec2 q = abs(P.xy - SC);
    if (h.m == M_FIG) {
      col = shadeFigure(P, h.n, rd);
    } else if (h.m == M_FRAME && h.n.z > 0.5 && q.x < SH.x && q.y < SH.y) {
      col = toLin(textureGrad(uScreen, (P.xy - (SC - SH)) / (2.0 * SH), gx, gy).rgb) * uWallGain;
      onScreen = 1.0;
    } else if (h.m == M_FLOOR) {
      col = shadeFloor(P, rd);
    } else if (h.m == M_NONE) {
      col = vec3(0.0);
    } else {
      col = shadeSurface(P, h.n, h.m, rd);
    }
  }
  float T = min(h.t, 80.0);
  col *= exp(-0.012 * T);
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  col += beams(ro, rd, T, jit) * uBeam;
  col += motes(ro, rd, T) * uBeam;
  outColor = vec4(col * uHdrScale, onScreen);
}`;

  /* ---------------------------------------------------------------- post */
  const DOWN_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform float uPrefilter;
uniform float uThreshold;
vec3 tp(vec2 o) { return texture(uSrc, vUv + o * uSrcTexel).rgb; }
void main() {
  vec3 a = tp(vec2(-2.0, 2.0)), b = tp(vec2(0.0, 2.0)), c = tp(vec2(2.0, 2.0));
  vec3 d = tp(vec2(-2.0, 0.0)), e = tp(vec2(0.0)), f = tp(vec2(2.0, 0.0));
  vec3 g = tp(vec2(-2.0, -2.0)), h = tp(vec2(0.0, -2.0)), i = tp(vec2(2.0, -2.0));
  vec3 j = tp(vec2(-1.0, 1.0)), k = tp(vec2(1.0, 1.0)), l = tp(vec2(-1.0, -1.0)), m = tp(vec2(1.0, -1.0));
  vec3 col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  if (uPrefilter > 0.5) {
    float br = max(col.r, max(col.g, col.b));
    float knee = uThreshold * 0.5;
    float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - uThreshold) / max(br, 1e-4);
  }
  outColor = vec4(col, 1.0);
}`;

  const UP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform float uRadius;
void main() {
  vec2 t = uSrcTexel * uRadius;
  vec3 c = texture(uSrc, vUv).rgb * 4.0;
  c += (texture(uSrc, vUv + vec2(-t.x, 0.0)).rgb + texture(uSrc, vUv + vec2(t.x, 0.0)).rgb
      + texture(uSrc, vUv + vec2(0.0, -t.y)).rgb + texture(uSrc, vUv + vec2(0.0, t.y)).rgb) * 2.0;
  c += texture(uSrc, vUv - t).rgb + texture(uSrc, vUv + t).rgb
     + texture(uSrc, vUv + vec2(-t.x, t.y)).rgb + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb;
  outColor = vec4(c / 16.0, 1.0);
}`;

  const COMPOSITE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform float uBloomK;
uniform float uExposure;
uniform float uVignette;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 dc = vUv - 0.5;
  vec4 s = texture(uScene, vUv);
  vec3 col = s.rgb + texture(uBloom, vUv).rgb * uBloomK;
  col = aces(col * uExposure);
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 graded = col * mix(vec3(0.8, 0.97, 1.05), vec3(1.03, 1.0, 0.965), smoothstep(0.05, 0.75, l));
  graded = mix(vec3(l), graded, 0.8);
  col = mix(graded, col, clamp(s.a, 0.0, 1.0) * 0.7);
  col += vec3(0.0005, 0.0009, 0.0011) * (1.0 - col);
  col *= 1.0 - uVignette * pow(clamp(length(dc * vec2(1.0, 1.2)) * 1.32, 0.0, 1.0), 2.4);
  outColor = vec4(pow(clamp(col, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

  const FINAL_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform float uDither;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  const vec3 LUMA = vec3(0.299, 0.587, 0.114);
  vec2 uv = vUv;
  vec3 nw = texture(uSrc, uv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 ne = texture(uSrc, uv + vec2(1.0, -1.0) * uTexel).rgb;
  vec3 sw = texture(uSrc, uv + vec2(-1.0, 1.0) * uTexel).rgb;
  vec3 se = texture(uSrc, uv + vec2(1.0, 1.0) * uTexel).rgb;
  vec3 m = texture(uSrc, uv).rgb;
  float lNW = dot(nw, LUMA), lNE = dot(ne, LUMA), lSW = dot(sw, LUMA), lSE = dot(se, LUMA), lM = dot(m, LUMA);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-8.0), vec2(8.0)) * uTexel;
  vec3 a = 0.5 * (texture(uSrc, uv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(uSrc, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 b = a * 0.5 + 0.25 * (texture(uSrc, uv - dir * 0.5).rgb + texture(uSrc, uv + dir * 0.5).rgb);
  float lB = dot(b, LUMA);
  vec3 col = (lB < lMin || lB > lMax) ? a : b;
  col += (hash(gl_FragCoord.xy) - 0.5) * uDither;
  outColor = vec4(col, 1.0);
}`;

  /* ============================================================ renderer */

  function createRenderer(canvas, opts) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) return null;

    // HDR targets where the device can render to them (some phones only offer the half-float extension);
    // otherwise the scene is stored at a quarter of its range in plain RGBA8.
    const floatExt = gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float');
    const floatRT = !!floatExt && (() => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null);
      const f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(f);
      gl.deleteTexture(t);
      return ok;
    })();
    const HDR = floatRT ? { internal: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE };
    const hdrScale = floatRT ? 1 : 0.25;

    // Shaders are linked without asking for the result, so that browsers with
    // KHR_parallel_shader_compile can do the slow part off the main thread.
    const parallel = gl.getExtension('KHR_parallel_shader_compile');
    function compile(type, src) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT);
    function program(fsSrc) {
      const p = gl.createProgram();
      const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
      gl.attachShader(p, vs);
      gl.attachShader(p, fs);
      gl.bindAttribLocation(p, 0, 'aPos');
      gl.linkProgram(p);
      return { p, fs, u: {} };
    }
    const P = {
      wall: program(WALL_FRAG),
      scene: program(SCENE_FRAG),
      down: program(DOWN_FRAG),
      up: program(UP_FRAG),
      composite: program(COMPOSITE_FRAG),
      final: program(FINAL_FRAG),
    };

    function isReady() {
      if (!parallel || gl.isContextLost()) return true;
      return Object.values(P).every((x) => gl.getProgramParameter(x.p, parallel.COMPLETION_STATUS_KHR));
    }
    function finalize() {
      if (gl.isContextLost()) return;
      for (const [name, x] of Object.entries(P)) {
        if (!gl.getProgramParameter(x.p, gl.LINK_STATUS)) {
          throw new Error(`Program "${name}" failed to link:\n${gl.getProgramInfoLog(x.p)}\n${gl.getShaderInfoLog(x.fs)}\n${gl.getShaderInfoLog(vs)}`);
        }
        const n = gl.getProgramParameter(x.p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
          const info = gl.getActiveUniform(x.p, i);
          x.u[info.name] = gl.getUniformLocation(x.p, info.name);
        }
      }
    }

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    const maxAniso = aniso ? gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1;

    function sampling(mip) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    function framebuffer(tex) {
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      if (!ok && !gl.isContextLost()) throw new Error('Framebuffer incomplete');
      return fb;
    }
    function target(w, h, fmt) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internal, w, h, 0, fmt.format, fmt.type, null);
      sampling(false);
      return { tex, fb: framebuffer(tex), w, h };
    }
    function release(t) { if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); } }

    // The wall image keeps a full mip chain for blurred light, reflections and the relief.
    const tw = opts.wallWidth;
    const th = Math.round(tw * 9 / 16);
    const wallTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, wallTex);
    gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(tw, th))) + 1, gl.RGBA8, tw, th);
    sampling(true);
    const wallFb = framebuffer(wallTex);

    const blank = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([244, 246, 246, 255]));
    sampling(false);

    function imageTexture(img) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      sampling(true);
      if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxAniso));
      return tex;
    }

    const BLOOM_LEVELS = 5;
    let size = { w: 0, h: 0 };
    let sceneT = null;
    let ldrT = null;
    let bloomT = [];
    function ensureSize(w, h) {
      if (w === size.w && h === size.h) return;
      release(sceneT); release(ldrT); bloomT.forEach(release);
      sceneT = target(w, h, HDR);
      ldrT = target(w, h, { internal: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE });
      bloomT = [];
      for (let i = 0; i < BLOOM_LEVELS; i++) bloomT.push(target(Math.max(1, w >> (i + 1)), Math.max(1, h >> (i + 1)), HDR));
      size = { w, h };
    }

    function quad() { gl.bindVertexArray(vao); gl.drawArrays(gl.TRIANGLES, 0, 3); }
    function bindTex(unit, tex) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); }

    function drawWall(s) {
      const { p, u } = P.wall;
      gl.bindFramebuffer(gl.FRAMEBUFFER, wallFb);
      gl.viewport(0, 0, tw, th);
      gl.useProgram(p);
      gl.uniform1f(u.uTime, s.time);
      gl.uniform1i(u.uCur, s.cur);
      gl.uniform1i(u.uPrev, s.prev);
      gl.uniform1f(u.uMix, s.mix);
      gl.uniform1f(u.uAspCur, s.aspCur);
      gl.uniform1f(u.uAspPrev, s.aspPrev);
      gl.uniform3f(u.uPointer, s.pointer[0], s.pointer[1], s.pointer[2]);
      gl.uniform1f(u.uPower, s.power);
      gl.uniform1i(u.uFigCur, 1);
      gl.uniform1i(u.uFigPrev, 2);
      bindTex(1, s.texCur || blank);
      bindTex(2, s.texPrev || blank);
      quad();
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      bindTex(0, wallTex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    // GPU time per frame, when the browser exposes it; null otherwise.
    const timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const queries = { free: timer ? [gl.createQuery(), gl.createQuery(), gl.createQuery()] : [], busy: [], active: null, ms: null };
    function timerBegin() {
      if (!timer || queries.active || !queries.free.length) return;
      queries.active = queries.free.pop();
      gl.beginQuery(timer.TIME_ELAPSED_EXT, queries.active);
    }
    function timerEnd() {
      if (!queries.active) return;
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      queries.busy.push(queries.active);
      queries.active = null;
    }
    function gpuMs() {
      while (queries.busy.length && gl.getQueryParameter(queries.busy[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = queries.busy.shift();
        const ns = gl.getQueryParameter(q, gl.QUERY_RESULT);
        if (!gl.getParameter(timer.GPU_DISJOINT_EXT)) queries.ms = ns / 1e6;
        queries.free.push(q);
      }
      return queries.ms;
    }

    function drawFrame(c) {
      timerBegin();
      const w = canvas.width;
      const h = canvas.height;
      ensureSize(w, h);

      // scene
      let { p, u } = P.scene;
      gl.bindFramebuffer(gl.FRAMEBUFFER, sceneT.fb);
      gl.viewport(0, 0, w, h);
      gl.useProgram(p);
      bindTex(0, wallTex);
      gl.uniform1i(u.uScreen, 0);
      gl.uniform2f(u.uRes, w, h);
      gl.uniform2f(u.uTexel, 1 / tw, 1 / th);
      gl.uniform1f(u.uTime, c.time);
      gl.uniform3fv(u.uCamPos, c.pos);
      gl.uniform3fv(u.uCamTarget, c.tgt);
      gl.uniform1f(u.uFov, c.fov * Math.PI / 180);
      gl.uniform1f(u.uRoll, c.roll || 0);
      gl.uniform1f(u.uRelief, c.relief);
      gl.uniform1f(u.uGain, c.gain);
      gl.uniform1f(u.uWallGain, c.wallGain);
      gl.uniform1f(u.uSteps, c.steps);
      gl.uniform1f(u.uVolSteps, c.volSteps);
      gl.uniform4f(u.uFig, c.fig[0], c.fig[1], c.fig[2], c.fig[3]);
      gl.uniform1f(u.uBeam, c.beam);
      gl.uniform1f(u.uHdrScale, hdrScale);
      quad();

      // bloom: downsample (with a soft threshold on the first step), then tent upsample
      ({ p, u } = P.down);
      gl.useProgram(p);
      gl.uniform1i(u.uSrc, 0);
      gl.uniform1f(u.uThreshold, 0.85 * hdrScale);
      let src = sceneT;
      for (let i = 0; i < BLOOM_LEVELS; i++) {
        const dst = bloomT[i];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, dst.w, dst.h);
        bindTex(0, src.tex);
        gl.uniform2f(u.uSrcTexel, 1 / src.w, 1 / src.h);
        gl.uniform1f(u.uPrefilter, i === 0 ? 1 : 0);
        quad();
        src = dst;
      }
      ({ p, u } = P.up);
      gl.useProgram(p);
      gl.uniform1i(u.uSrc, 0);
      gl.uniform1f(u.uRadius, 1.0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
        const s = bloomT[i];
        const dst = bloomT[i - 1];
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, dst.w, dst.h);
        bindTex(0, s.tex);
        gl.uniform2f(u.uSrcTexel, 1 / s.w, 1 / s.h);
        quad();
      }
      gl.disable(gl.BLEND);

      // composite and grade
      ({ p, u } = P.composite);
      gl.bindFramebuffer(gl.FRAMEBUFFER, ldrT.fb);
      gl.viewport(0, 0, w, h);
      gl.useProgram(p);
      bindTex(0, sceneT.tex);
      bindTex(1, bloomT[0].tex);
      gl.uniform1i(u.uScene, 0);
      gl.uniform1i(u.uBloom, 1);
      gl.uniform1f(u.uBloomK, c.bloom);
      gl.uniform1f(u.uExposure, c.exposure / hdrScale);
      gl.uniform1f(u.uVignette, c.vignette);
      quad();

      // FXAA and grain to the canvas
      ({ p, u } = P.final);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(p);
      bindTex(0, ldrT.tex);
      gl.uniform1i(u.uSrc, 0);
      gl.uniform2f(u.uTexel, 1 / w, 1 / h);
      gl.uniform1f(u.uDither, c.dither);
      quad();
      timerEnd();
    }

    // Debug only: read one texel back from the wall image.
    function probeWall() {
      const px = new Uint8Array(4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, wallFb);
      gl.readPixels(tw >> 1, th >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return Array.from(px);
    }

    return { gl, floatRT, isReady, finalize, imageTexture, drawWall, drawFrame, probeWall, gpuMs };
  }

  window.CinemaGL = { createRenderer };
})();
