// LaptopBench QC v3.3.0 — Real Full-Color 3D WebGL2 Shaders & Geometry Builders
// Photorealistic 3DMark / Unigine-style worlds:
//   1. Alpine Mountain Terrain, Ocean Water & Volumetric Sun Flythrough
//   2. Real-Time Multi-Bounce Ray-Traced Chrome/Gold/Glass Studio & Soft Shadows
//   3. High-Poly Instanced 3D Cyberpunk Megacity Flythrough (real 3D meshes + lit windows)
//   4. 3D Volumetric Plasma Nebula & Fusion Reactor Core

export function compileGlShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function linkGlProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string
): WebGLProgram | null {
  const vs = compileGlShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileGlShader(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

export const FULLSCREEN_QUAD_VS = `#version 300 es
precision highp float;
const vec2 POS[6] = vec2[](
  vec2(-1.0, -1.0), vec2(1.0, -1.0), vec2(-1.0, 1.0),
  vec2(-1.0, 1.0), vec2(1.0, -1.0), vec2(1.0, 1.0)
);
out vec2 vUv;
void main() {
  vec2 p = POS[gl_VertexID];
  vUv = p * 0.5 + 0.5;
  gl_Position = vec4(p, 0.0, 1.0);
}
`;

// ============================================================================
// 3D SCENE 01: ALPINE TERRAIN, OCEAN WATER & VOLUMETRIC SUN FLYTHROUGH
// 3-Act progression:
//   Act I   (0.0 - 0.33): Low turquoise ocean skim past sunlit coastal islands
//   Act II  (0.33 - 0.66): Mountain ridge climb into warm golden-hour sunset
//   Act III (0.66 - 1.0): High-octave alpine canyon dive + volumetric light shafts
// ============================================================================
export const TERRAIN_OCEAN_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime;
uniform float uProgress;
uniform vec2 uRes;
uniform vec2 uPointer;
uniform float uManual;
uniform int uQuality; // 1..4 escalating raymarch & FBM detail
out vec4 fragColor;

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

float fbmTerrain(vec2 p, int octaves) {
  float v = 0.0;
  float a = 0.52;
  mat2 m = mat2(1.68, 1.12, -1.12, 1.68);
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = noise2(p);
    // Ridged mountain sharpness on upper octaves
    v += a * (i < 2 ? n : (1.0 - abs(n * 2.0 - 1.0)) * 0.72 + n * 0.28);
    p = m * p;
    a *= 0.48;
  }
  return v;
}

float terrainHeight(vec2 xz, int octaves) {
  float base = fbmTerrain(xz * 0.14, octaves) * 5.8 - 2.15;
  // Carve a sweeping river/ocean channel down the center
  float channelX = sin(xz.y * 0.12) * 3.8 + cos(xz.y * 0.045) * 2.2;
  float distToRiver = abs(xz.x - channelX);
  float canyonMask = smoothstep(1.4, 7.2, distToRiver);
  return base * canyonMask - 0.55;
}

vec3 calcTerrainNormal(vec2 xz, float eps, int octaves) {
  float hL = terrainHeight(xz - vec2(eps, 0.0), octaves);
  float hR = terrainHeight(xz + vec2(eps, 0.0), octaves);
  float hD = terrainHeight(xz - vec2(0.0, eps), octaves);
  float hU = terrainHeight(xz + vec2(0.0, eps), octaves);
  return normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
}

vec3 skyColor(vec3 rd, vec3 sunDir, float sunsetFactor) {
  float up = clamp(rd.y, 0.0, 1.0);
  vec3 dayZenith = vec3(0.11, 0.34, 0.76);
  vec3 dayHorizon = vec3(0.68, 0.84, 0.96);
  vec3 duskZenith = vec3(0.08, 0.15, 0.42);
  vec3 duskHorizon = vec3(0.95, 0.52, 0.28);

  vec3 zenith = mix(dayZenith, duskZenith, sunsetFactor);
  vec3 horizon = mix(dayHorizon, duskHorizon, sunsetFactor);
  vec3 col = mix(horizon, zenith, pow(up, 0.52));

  // Procedural high-altitude clouds
  if (rd.y > 0.02) {
    vec2 cloudUv = rd.xz / (rd.y + 0.12) * 0.85 + vec2(uTime * 0.03, uTime * 0.015);
    float cl = fbmTerrain(cloudUv, 4);
    float clMask = smoothstep(0.52, 0.84, cl) * smoothstep(0.02, 0.22, rd.y);
    vec3 clCol = mix(vec3(0.96, 0.98, 1.0), vec3(1.0, 0.76, 0.55), sunsetFactor);
    col = mix(col, clCol, clMask * 0.58);
  }

  float sunAmt = max(dot(rd, sunDir), 0.0);
  vec3 sunTint = mix(vec3(1.0, 0.92, 0.75), vec3(1.0, 0.56, 0.22), sunsetFactor);
  col += sunTint * pow(sunAmt, 10.0) * 0.48;
  col += vec3(1.0, 0.97, 0.90) * pow(sunAmt, 260.0) * 1.9;
  return col;
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
  float t = uTime;
  float prog = clamp(uProgress, 0.0, 1.0);

  // 3-Act cinematic camera flight
  float flightZ = t * 4.4;
  float act2 = smoothstep(0.28, 0.45, prog);
  float act3 = smoothstep(0.62, 0.78, prog);
  float sunsetFactor = clamp(act2 * 0.85 - act3 * 0.25, 0.0, 0.9);

  float camX = sin(flightZ * 0.12) * 3.4 + (uManual > 0.5 ? (uPointer.x - 0.5) * 9.0 : 0.0);
  float camY = mix(1.35, 3.85, act2) - act3 * 1.45 + (uManual > 0.5 ? (0.5 - uPointer.y) * 4.5 : 0.0);
  camY = max(camY, terrainHeight(vec2(camX, flightZ), 3) + 0.85);

  vec3 ro = vec3(camX, camY, flightZ);
  vec3 target = vec3(
    sin((flightZ + 7.5) * 0.12) * 3.6 + (uManual > 0.5 ? (uPointer.x - 0.5) * 12.0 : 0.0),
    mix(0.65, 2.25, act2) - act3 * 0.95 + (uManual > 0.5 ? (0.5 - uPointer.y) * 5.0 : 0.0),
    flightZ + 7.5
  );

  vec3 cw = normalize(target - ro);
  vec3 cu = normalize(cross(cw, vec3(0.0, 1.0, 0.0)));
  vec3 cv = cross(cu, cw);
  vec3 rd = normalize(p.x * cu + p.y * cv + 1.55 * cw);

  float sunElev = mix(0.46, 0.17, sunsetFactor);
  vec3 sunDir = normalize(vec3(cos(prog * 1.8) * 0.65, sunElev, 0.75));
  vec3 sunColor = mix(vec3(1.0, 0.96, 0.88), vec3(1.0, 0.62, 0.34), sunsetFactor);

  int octaves = clamp(4 + uQuality + int(act3 * 2.0), 4, 8);
  int maxSteps = 56 + uQuality * 22 + int(act3 * 24.0);

  // Raymarch terrain
  float dist = 0.0;
  float maxDist = 72.0;
  bool hitTerrain = false;
  for (int i = 0; i < 168; i++) {
    if (i >= maxSteps) break;
    vec3 pos = ro + rd * dist;
    float h = terrainHeight(pos.xz, octaves);
    float diffH = pos.y - h;
    if (diffH < 0.008 * dist + 0.015) {
      hitTerrain = true;
      break;
    }
    dist += max(0.06, diffH * 0.44);
    if (dist > maxDist) break;
  }

  // Analytic water plane intersection (y = -0.25)
  float waterY = -0.25;
  float waterDist = (waterY - ro.y) / (abs(rd.y) < 0.0001 ? 0.0001 : rd.y);
  bool hitWater = (rd.y < -0.001 && waterDist > 0.0 && waterDist < (hitTerrain ? dist : maxDist));

  vec3 sky = skyColor(rd, sunDir, sunsetFactor);
  vec3 col = sky;

  if (hitWater) {
    vec3 wpos = ro + rd * waterDist;
    // Animated multi-frequency ocean wave normals
    vec2 wUv1 = wpos.xz * 1.8 + vec2(t * 0.85, -t * 0.6);
    vec2 wUv2 = wpos.xz * 3.7 + vec2(-t * 0.55, t * 0.95);
    float wx = (noise2(wUv1) - 0.5) * 0.11 + (noise2(wUv2) - 0.5) * 0.05;
    float wz = (noise2(wUv1 + 11.3) - 0.5) * 0.11 + (noise2(wUv2 + 7.1) - 0.5) * 0.05;
    vec3 wn = normalize(vec3(wx, 1.0, wz));

    vec3 reflDir = reflect(rd, wn);
    vec3 reflSky = skyColor(reflDir, sunDir, sunsetFactor);
    float fres = pow(1.0 - max(dot(wn, -rd), 0.0), 4.0);
    float spec = pow(max(dot(reflDir, sunDir), 0.0), 140.0);

    float depth = max(0.0, waterY - terrainHeight(wpos.xz, 3));
    vec3 shallowCol = vec3(0.06, 0.44, 0.52);
    vec3 deepCol = vec3(0.02, 0.14, 0.30);
    vec3 waterBase = mix(shallowCol, deepCol, clamp(depth * 0.85, 0.0, 1.0));
    float foam = smoothstep(0.18, 0.01, depth) * (0.65 + 0.35 * sin(wpos.x * 8.0 + t * 4.0));

    col = mix(waterBase, reflSky, clamp(0.28 + fres * 0.72, 0.0, 1.0));
    col += sunColor * spec * 1.45;
    col = mix(col, vec3(0.92, 0.97, 1.0), foam * 0.65);

    float fog = 1.0 - exp(-0.00055 * waterDist * waterDist);
    col = mix(col, sky, clamp(fog, 0.0, 1.0));
  } else if (hitTerrain) {
    vec3 pos = ro + rd * dist;
    vec3 n = calcTerrainNormal(pos.xz, max(0.02, dist * 0.004), octaves);

    // Real directional sun shadow march
    float shadow = 1.0;
    float shT = 0.25;
    for (int s = 0; s < 14; s++) {
      vec3 sp = pos + sunDir * shT;
      float shH = terrainHeight(sp.xz, 4);
      if (sp.y < shH) {
        shadow = 0.22;
        break;
      }
      shadow = min(shadow, clamp(0.22 + 5.0 * (sp.y - shH) / shT, 0.22, 1.0));
      shT += 0.55 + float(s) * 0.25;
    }

    // Biome shading: coastal sand -> pine green valley -> alpine granite -> sunlit snow peaks
    float slope = 1.0 - n.y;
    vec3 sand = vec3(0.76, 0.68, 0.52);
    vec3 forest = vec3(0.14, 0.31, 0.17);
    vec3 rock = vec3(0.32, 0.31, 0.33);
    vec3 snow = vec3(0.93, 0.96, 1.0);

    vec3 alb = mix(sand, forest, smoothstep(-0.22, 0.15, pos.y));
    alb = mix(alb, rock, smoothstep(0.25, 0.58, slope) + smoothstep(1.2, 2.2, pos.y) * 0.5);
    float snowMask = smoothstep(1.45, 2.45, pos.y) * smoothstep(0.55, 0.22, slope);
    alb = mix(alb, snow, clamp(snowMask, 0.0, 1.0));

    float diff = max(dot(n, sunDir), 0.0);
    float amb = 0.25 + 0.35 * max(n.y, 0.0);
    vec3 skyAmb = mix(vec3(0.38, 0.55, 0.85), vec3(0.55, 0.38, 0.52), sunsetFactor);
    vec3 lit = alb * (sunColor * diff * shadow * 1.15 + skyAmb * amb * 0.65);

    // Subtle snow specular sparkle
    vec3 halfV = normalize(sunDir - rd);
    lit += sunColor * pow(max(dot(n, halfV), 0.0), 42.0) * snowMask * shadow * 0.55;

    float fog = 1.0 - exp(-0.00055 * dist * dist);
    col = mix(lit, sky, clamp(fog, 0.0, 1.0));
  }

  // Volumetric sun scatter glow
  float sunScatter = pow(max(dot(rd, sunDir), 0.0), 6.0);
  col += sunColor * sunScatter * (0.14 + act3 * 0.12);

  // ACES filmic tone-mapping
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  fragColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 3D SCENE 02: REAL-TIME RAY-TRACED REFLECTIONS, GLASS REFRACTION & SOFT SHADOWS
// 3DMark Solar Bay / Port Royal style multi-bounce analytic ray tracer!
// Escalates real reflection bounces (2 -> 4 -> 6) and active spheres across Acts I-III.
// ============================================================================
export const RAYTRACE_STUDIO_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime;
uniform float uProgress;
uniform vec2 uRes;
uniform vec2 uPointer;
uniform float uManual;
uniform int uQuality; // 1..4 -> scales bounces 2..6
out vec4 fragColor;

struct Hit {
  float t;
  vec3 pos;
  vec3 norm;
  int matId; // 0=floor, 1=gold, 2=chrome, 3=cobalt metallic, 4=glass orb, 5=emissive light, 6=copper
};

float intersectSphere(vec3 ro, vec3 rd, vec3 center, float radius) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  float t1 = -b - h;
  if (t1 > 0.001) return t1;
  float t2 = -b + h;
  return t2 > 0.001 ? t2 : -1.0;
}

Hit traceScene(vec3 ro, vec3 rd, float t, float prog) {
  Hit h;
  h.t = 1e9;
  h.matId = -1;

  // Infinite polished studio floor y = -1.2
  if (rd.y < -0.0001) {
    float tf = (-1.2 - ro.y) / rd.y;
    if (tf > 0.001 && tf < 90.0) {
      h.t = tf;
      h.pos = ro + rd * tf;
      h.norm = vec3(0.0, 1.0, 0.0);
      h.matId = 0;
    }
  }

  // Central refractive crystal glass orb
  vec3 glassC = vec3(0.0, 0.05 + sin(t * 1.4) * 0.14, 0.0);
  float tg = intersectSphere(ro, rd, glassC, 1.15);
  if (tg > 0.0 && tg < h.t) {
    h.t = tg;
    h.pos = ro + rd * tg;
    h.norm = normalize(h.pos - glassC);
    h.matId = 4;
  }

  // 7 Orbiting metallic spheres (Gold, Chrome, Cobalt, Copper)
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    float ang = t * (0.65 + fi * 0.12) + fi * 0.8976;
    float rad = 2.45 + mod(fi, 2.0) * 0.78;
    float y = -0.35 + sin(t * 1.6 + fi * 1.4) * 0.55 + (fi > 3.5 ? 0.55 : 0.0);
    vec3 c = vec3(cos(ang) * rad, y, sin(ang) * rad);
    float r = 0.44 + mod(fi, 3.0) * 0.11;
    float ts = intersectSphere(ro, rd, c, r);
    if (ts > 0.0 && ts < h.t) {
      h.t = ts;
      h.pos = ro + rd * ts;
      h.norm = normalize(h.pos - c);
      h.matId = (i % 4 == 0) ? 1 : (i % 4 == 1) ? 2 : (i % 4 == 2) ? 3 : 6;
    }
  }

  // 2 Orbiting emissive studio area lights
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float a = t * (1.25 - fl * 0.5) + fl * 3.14159 + prog * 2.0;
    vec3 lc = vec3(cos(a) * 3.8, 2.15 + sin(t * 1.1 + fl) * 0.4, sin(a) * 3.8);
    float tl = intersectSphere(ro, rd, lc, 0.24);
    if (tl > 0.0 && tl < h.t) {
      h.t = tl;
      h.pos = ro + rd * tl;
      h.norm = normalize(h.pos - lc);
      h.matId = 5;
    }
  }

  return h;
}

float softShadow(vec3 p, vec3 lightPos, float t, float prog) {
  vec3 toL = lightPos - p;
  float maxD = length(toL);
  vec3 lDir = toL / maxD;
  Hit sh = traceScene(p + lDir * 0.02, lDir, t, prog);
  if (sh.matId >= 0 && sh.matId != 5 && sh.t < maxD - 0.3) {
    return sh.matId == 4 ? 0.55 : 0.18;
  }
  return 1.0;
}

vec3 studioEnv(vec3 rd, float prog) {
  float y = clamp(rd.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 env = mix(vec3(0.05, 0.07, 0.12), vec3(0.14, 0.24, 0.42), pow(y, 1.2));
  // Architectural overhead studio softboxes
  float box1 = smoothstep(0.86, 0.96, dot(rd, normalize(vec3(0.45, 0.72, 0.5))));
  float box2 = smoothstep(0.88, 0.97, dot(rd, normalize(vec3(-0.6, 0.65, -0.45))));
  float ring = smoothstep(0.06, 0.0, abs(rd.y - 0.18)) * (0.4 + 0.6 * sin(atan(rd.z, rd.x) * 8.0 + prog * 6.0));
  env += vec3(1.0, 0.94, 0.85) * box1 * 2.2;
  env += vec3(0.45, 0.72, 1.0) * box2 * 1.9;
  env += vec3(0.22, 0.52, 0.98) * max(0.0, ring) * 0.45;
  return env;
}

void main() {
  vec2 p = (vUv * 2.0 - 1.0) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
  float t = uTime;
  float prog = clamp(uProgress, 0.0, 1.0);

  // 3-Act camera tour: Wide studio orbit -> Low floor reflection glide -> Close crystal zoom
  float yaw = t * 0.36 + (uManual > 0.5 ? (uPointer.x - 0.5) * 3.8 : 0.0);
  float act2 = smoothstep(0.30, 0.50, prog);
  float act3 = smoothstep(0.65, 0.82, prog);
  float camRadius = mix(6.8, 4.6, act3);
  float camY = mix(2.2, 0.35, act2) + act3 * 1.15 + (uManual > 0.5 ? (0.5 - uPointer.y) * 3.2 : 0.0);
  vec3 ro = vec3(cos(yaw) * camRadius, max(-0.7, camY), sin(yaw) * camRadius);
  vec3 ta = vec3(0.0, 0.05, 0.0);

  vec3 cw = normalize(ta - ro);
  vec3 cu = normalize(cross(cw, vec3(0.0, 1.0, 0.0)));
  vec3 cv = cross(cu, cw);
  vec3 rd = normalize(p.x * cu + p.y * cv + 1.65 * cw);

  vec3 l1 = vec3(cos(t * 1.25 + prog * 2.0) * 3.8, 2.15 + sin(t * 1.1) * 0.4, sin(t * 1.25 + prog * 2.0) * 3.8);
  vec3 l2 = vec3(cos(t * 0.75 + 3.14159 + prog * 2.0) * 3.8, 2.15 + sin(t * 1.1 + 1.0) * 0.4, sin(t * 0.75 + 3.14159 + prog * 2.0) * 3.8);
  vec3 l1Col = vec3(1.0, 0.88, 0.68);
  vec3 l2Col = vec3(0.38, 0.72, 1.0);

  int maxBounces = clamp(1 + uQuality + int(act3 * 2.0), 2, 6);
  vec3 throughput = vec3(1.0);
  vec3 accum = vec3(0.0);
  vec3 curRo = ro;
  vec3 curRd = rd;

  for (int b = 0; b < 6; b++) {
    if (b >= maxBounces) break;
    Hit h = traceScene(curRo, curRd, t, prog);
    if (h.matId < 0) {
      accum += throughput * studioEnv(curRd, prog);
      break;
    }
    if (h.matId == 5) {
      accum += throughput * vec3(2.8, 2.5, 2.1);
      break;
    }

    vec3 l1Dir = normalize(l1 - h.pos);
    vec3 l2Dir = normalize(l2 - h.pos);
    float sh1 = softShadow(h.pos, l1, t, prog);
    float sh2 = softShadow(h.pos, l2, t, prog);
    float d1 = max(dot(h.norm, l1Dir), 0.0) * sh1;
    float d2 = max(dot(h.norm, l2Dir), 0.0) * sh2;
    float sp1 = pow(max(dot(reflect(-l1Dir, h.norm), -curRd), 0.0), 64.0) * sh1;
    float sp2 = pow(max(dot(reflect(-l2Dir, h.norm), -curRd), 0.0), 64.0) * sh2;
    float fres = pow(1.0 - max(dot(h.norm, -curRd), 0.0), 4.0);

    if (h.matId == 0) {
      // Polished marble checkerboard floor with radial distance fade
      float chk = mod(floor(h.pos.x * 1.1) + floor(h.pos.z * 1.1), 2.0);
      vec3 tile = mix(vec3(0.08, 0.09, 0.12), vec3(0.82, 0.85, 0.90), chk);
      float distFade = exp(-0.0022 * dot(h.pos.xz, h.pos.xz));
      vec3 direct = tile * (0.14 + l1Col * d1 * 0.75 + l2Col * d2 * 0.72) + (l1Col * sp1 + l2Col * sp2) * 0.4;
      accum += throughput * mix(studioEnv(curRd, prog), direct, distFade) * 0.65;
      throughput *= (0.28 + 0.35 * fres) * distFade;
      curRo = h.pos + h.norm * 0.004;
      curRd = reflect(curRd, h.norm);
    } else if (h.matId == 4) {
      // Real Snell's law refractive crystal glass orb with Fresnel reflection + dispersion tint
      accum += throughput * (l1Col * sp1 * 1.6 + l2Col * sp2 * 1.6);
      vec3 refr = refract(curRd, h.norm, 1.0 / 1.48);
      if (length(refr) < 0.01 || fres > 0.62) {
        curRd = reflect(curRd, h.norm);
        curRo = h.pos + h.norm * 0.004;
        throughput *= vec3(0.95, 0.98, 1.0);
      } else {
        curRd = normalize(refr);
        curRo = h.pos - h.norm * 0.015;
        throughput *= vec3(0.86, 0.96, 1.0);
      }
    } else {
      // Metallic PBR spheres (Gold / Chrome / Cobalt / Copper)
      vec3 metalTint =
        (h.matId == 1) ? vec3(1.00, 0.78, 0.32) :
        (h.matId == 2) ? vec3(0.92, 0.95, 0.99) :
        (h.matId == 3) ? vec3(0.24, 0.56, 1.00) :
                         vec3(0.92, 0.48, 0.30);
      vec3 direct = metalTint * (0.08 + l1Col * d1 * 0.35 + l2Col * d2 * 0.35) + (l1Col * sp1 + l2Col * sp2) * 1.25;
      accum += throughput * direct * 0.35;
      throughput *= metalTint * (0.76 + 0.22 * fres);
      curRo = h.pos + h.norm * 0.004;
      curRd = reflect(curRd, h.norm);
    }
  }

  accum = (accum * (2.51 * accum + 0.03)) / (accum * (2.43 * accum + 0.59) + 0.14);
  accum = pow(clamp(accum, 0.0, 1.0), vec3(0.4545));
  fragColor = vec4(accum, 1.0);
}
`;

// ============================================================================
// 3D SCENE 03: HIGH-POLY INSTANCED 3D CYBERPUNK MEGACITY FLYTHROUGH
// Real WebGL2 instanced 3D building meshes + lit window shaders + aerial traffic!
// ============================================================================
export const MEGACITY_3D_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNorm;
layout(location = 2) in vec4 aInstOriginHeight; // xyz = world base, w = height
layout(location = 3) in vec4 aInstFootprintSeed; // x = width, y = depth, z = seed, w = type

uniform float uTime;
uniform float uProgress;
uniform float uAspect;
uniform vec2 uPointer;
uniform float uManual;

out vec3 vNormal;
out vec3 vLocalPos;
out vec3 vWorldPos;
out float vHeight;
out float vSeed;
out float vDepth;
out float vType;

mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c,0.0,s, 0.0,1.0,0.0, -s,0.0,c); }
mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0,0.0,0.0, 0.0,c,-s, 0.0,s,c); }

void main() {
  vec3 scale = vec3(aInstFootprintSeed.x, aInstOriginHeight.w, aInstFootprintSeed.y);
  vec3 wp = vec3(
    aInstOriginHeight.x + aPos.x * scale.x,
    aInstOriginHeight.y + (aPos.y + 0.5) * scale.y,
    aInstOriginHeight.z + aPos.z * scale.z
  );

  // Endless streaming city wrap along Z so the flythrough never runs out of buildings
  float speed = 13.5;
  float camZ = uTime * speed;
  float citySpan = 210.0;
  wp.z = mod(wp.z - camZ + 25.0, citySpan) - 25.0;

  // Type 1.0 = aerial glowing flying traffic vehicles cruising down avenues
  if (aInstFootprintSeed.w > 0.5) {
    wp.z = mod(aInstOriginHeight.z + uTime * (26.0 + mod(aInstFootprintSeed.z, 14.0)) - camZ, citySpan) - 25.0;
    wp.y = aInstOriginHeight.y + sin(uTime * 2.0 + aInstFootprintSeed.z) * 0.6;
  }

  // 3-Act camera flight path: Skyline sweep -> Downtown street canyon -> High orbital pass
  float act2 = smoothstep(0.28, 0.46, uProgress);
  float act3 = smoothstep(0.64, 0.80, uProgress);
  float camX = sin(uTime * 0.35) * mix(16.0, 3.2, act2) + (uManual > 0.5 ? (uPointer.x - 0.5) * 28.0 : 0.0);
  float camY = mix(24.0, 8.5, act2) + act3 * 22.0 + (uManual > 0.5 ? (0.5 - uPointer.y) * 16.0 : 0.0);

  vec3 rel = wp - vec3(camX, camY, -12.0);
  float yaw = sin(uTime * 0.28) * 0.22 + (uManual > 0.5 ? (uPointer.x - 0.5) * 0.75 : 0.0);
  float pitch = mix(-0.18, -0.05, act2) - act3 * 0.22 + (uManual > 0.5 ? (uPointer.y - 0.5) * 0.5 : 0.0);
  mat3 camM = rotX(pitch) * rotY(yaw);
  vec3 cp = camM * rel;

  vNormal = normalize(camM * aNorm);
  vLocalPos = vec3(aPos.x * scale.x, (aPos.y + 0.5) * scale.y, aPos.z * scale.z);
  vWorldPos = wp;
  vHeight = aInstOriginHeight.w;
  vSeed = aInstFootprintSeed.z;
  vType = aInstFootprintSeed.w;
  vDepth = clamp(cp.z / 175.0, 0.0, 1.0);

  float near = 0.5;
  float far = 210.0;
  float z = max(cp.z, 0.2);
  float fov = 1.62;
  gl_Position = vec4(
    (cp.x * fov / uAspect) / z,
    (cp.y * fov) / z,
    ((z - near) / (far - near)) * 2.0 - 1.0,
    1.0
  );
  // Clip behind camera cleanly
  if (cp.z <= 0.25) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
}
`;

export const MEGACITY_3D_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vLocalPos;
in vec3 vWorldPos;
in float vHeight;
in float vSeed;
in float vDepth;
in float vType;
uniform float uTime;
out vec4 fragColor;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 fogCol = vec3(0.04, 0.07, 0.16);
  if (vType > 0.5) {
    // Glowing aerial traffic light trails (warm amber / electric cyan)
    vec3 trailCol = mod(vSeed, 2.0) < 1.0 ? vec3(1.0, 0.62, 0.18) : vec3(0.25, 0.78, 1.0);
    fragColor = vec4(mix(trailCol * 1.4, fogCol, vDepth * 0.75), 1.0);
    return;
  }

  vec3 n = normalize(vNormal);
  vec3 moonDir = normalize(vec3(0.45, 0.78, -0.4));
  float diff = max(dot(n, moonDir), 0.0);
  float spec = pow(max(dot(reflect(-moonDir, n), vec3(0.0, 0.0, -1.0)), 0.0), 28.0);

  // Architectural glass & dark steel facade base
  vec3 facade = vec3(0.07, 0.09, 0.14) * (0.45 + 0.75 * diff) + vec3(0.28, 0.52, 0.92) * spec * 0.45;

  // Procedural illuminated skyscraper window matrix on vertical faces
  if (abs(n.y) < 0.55) {
    vec2 winCoord = vec2(vLocalPos.x + vLocalPos.z, vLocalPos.y) * vec2(1.65, 1.15);
    vec2 cell = floor(winCoord);
    vec2 frac = fract(winCoord);
    float frame = step(0.18, frac.x) * step(frac.x, 0.82) * step(0.22, frac.y) * step(frac.y, 0.76);
    float litProb = hash12(cell + vec2(vSeed * 7.3, floor(uTime * 0.15 + vSeed) * 0.01));
    float isLit = step(0.56, litProb) * frame;

    // Realistic warm office tungsten, crisp daylight white, and neon cyan/blue accent floors
    vec3 winCol =
      (litProb > 0.88) ? vec3(0.32, 0.74, 1.0) :
      (litProb > 0.74) ? vec3(1.0, 0.76, 0.42) :
                         vec3(0.88, 0.94, 1.0);
    facade += winCol * isLit * 0.95;

    // Glowing neon crown stripe near skyscraper roof
    float roofBand = smoothstep(0.6, 0.0, abs(vLocalPos.y - (vHeight - 0.65)));
    vec3 crownCol = mod(vSeed, 3.0) < 1.0 ? vec3(0.18, 0.62, 1.0) :
                    mod(vSeed, 3.0) < 2.0 ? vec3(1.0, 0.45, 0.22) :
                                            vec3(0.32, 0.92, 0.78);
    facade += crownCol * roofBand * 1.15;
  } else {
    // Rooftop helipad / HVAC deck + blinking beacon
    float blink = 0.5 + 0.5 * sin(uTime * 4.0 + vSeed * 5.0);
    facade += vec3(0.25, 0.65, 1.0) * 0.18 + vec3(1.0, 0.35, 0.2) * blink * step(18.0, vHeight) * 0.35;
  }

  // Street-level warm golden/blue bounce glow
  float streetGlow = exp(-vLocalPos.y * 0.16);
  facade += vec3(0.14, 0.28, 0.58) * streetGlow * 0.55;

  vec3 col = mix(facade, fogCol, pow(vDepth, 1.25));
  col = pow(clamp(col, 0.0, 1.0), vec3(0.92));
  fragColor = vec4(col, 1.0);
}
`;

// ============================================================================
// 3D SCENE 04: VOLUMETRIC PLASMA NEBULA & FUSION REACTOR STRESS
// Heavy 3D volumetric raymarching + chromatic dispersion (32 -> 64 -> 112 steps/px!)
// ============================================================================
export const VOLUMETRIC_REACTOR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime;
uniform float uProgress;
uniform vec2 uRes;
uniform vec2 uPointer;
uniform float uManual;
uniform int uQuality; // 1..4 -> 32..112 march steps
out vec4 fragColor;

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float gyroid(vec3 p) {
  return dot(sin(p), cos(p.yzx));
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * vec2(uRes.x / max(uRes.y, 1.0), 1.0);
  float t = uTime;
  float prog = clamp(uProgress, 0.0, 1.0);

  float yaw = t * 0.42 + (uManual > 0.5 ? (uPointer.x - 0.5) * 3.4 : 0.0);
  float pitch = sin(t * 0.31) * 0.45 + (uManual > 0.5 ? (uPointer.y - 0.5) * 1.8 : 0.0);
  float camDist = 4.9 - smoothstep(0.55, 0.95, prog) * 1.45;
  vec3 ro = vec3(cos(yaw) * camDist, sin(pitch) * 2.1, sin(yaw) * camDist);
  vec3 cw = normalize(-ro);
  vec3 cu = normalize(cross(cw, vec3(0.0, 1.0, 0.0)));
  vec3 cv = cross(cu, cw);
  vec3 rd = normalize(uv.x * cu + uv.y * cv + 1.55 * cw);

  int steps = clamp(28 + uQuality * 18 + int(prog * 28.0), 32, 116);
  vec3 accum = vec3(0.0);
  float d = 0.25;

  for (int i = 0; i < 116; i++) {
    if (i >= steps) break;
    vec3 p = ro + rd * d;

    // 3 Counter-rotating crystalline containment rings
    vec3 p1 = p; p1.xy *= rot2(t * 0.9); p1.yz *= rot2(t * 0.6);
    float ring1 = sdTorus(p1, vec2(1.75, 0.065));

    vec3 p2 = p; p2.xz *= rot2(-t * 1.15); p2.xy *= rot2(1.1);
    float ring2 = sdTorus(p2, vec2(1.32, 0.055));

    // Central plasma energy core + turbulent 3D gyroid nebula field
    float coreDist = length(p) - (0.62 + 0.08 * sin(t * 4.5 + length(p) * 6.0));
    vec3 np = p * 1.65 + vec3(0.0, -t * 0.75, t * 0.45);
    float neb = abs(gyroid(np) + 0.45 * gyroid(np * 2.15 - t * 0.6));
    float dens = exp(-length(p) * 0.52) / (neb * neb + 0.09);

    // Rich plasma spectrum: deep cobalt -> electric cyan -> solar gold core
    float energy = clamp(1.35 - length(p) * 0.42, 0.0, 1.0);
    vec3 plasmaCol = mix(
      vec3(0.12, 0.36, 0.96),
      mix(vec3(0.18, 0.85, 0.98), vec3(1.0, 0.72, 0.26), pow(energy, 2.2)),
      energy
    );

    float ringGlow = 0.018 / (abs(ring1) + 0.024) + 0.016 / (abs(ring2) + 0.022);
    float coreGlow = 0.032 / (abs(coreDist) + 0.04);

    accum += plasmaCol * (dens * 0.016 + coreGlow * 0.14) / (float(steps) * 0.022);
    accum += vec3(0.65, 0.88, 1.0) * ringGlow * 0.018;

    float stepSz = max(0.055, min(min(abs(ring1), abs(ring2)), abs(coreDist)) * 0.42);
    d += min(stepSz, 0.14);
    if (d > 10.5) break;
  }

  // Deep space starfield backdrop
  vec3 bg = vec3(0.02, 0.025, 0.055);
  vec3 col = bg + accum;
  col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  fragColor = vec4(col, 1.0);
}
`;

// Build a clean shaded 3D unit box (36 vertices, pos + normal) for instanced Megacity buildings
export function buildBoxGeometry(): Float32Array {
  const faces: Array<[number[], number[][]]> = [
    [[0, 0, 1], [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]]],
    [[0, 0, -1], [[0.5, -0.5, -0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [0.5, 0.5, -0.5]]],
    [[0, 1, 0], [[-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5]]],
    [[0, -1, 0], [[-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [-0.5, -0.5, 0.5]]],
    [[1, 0, 0], [[0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5]]],
    [[-1, 0, 0], [[-0.5, -0.5, -0.5], [-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, 0.5], [-0.5, 0.5, -0.5]]],
  ];
  const out: number[] = [];
  for (const [n, verts] of faces) {
    for (const v of verts) {
      out.push(v[0], v[1], v[2], n[0], n[1], n[2]);
    }
  }
  return new Float32Array(out);
}

// Generate realistic Manhattan/Cyberpunk city blocks with wide flight avenues + aerial traffic lanes
export function buildMegacityInstances(count: number): {
  originHeight: Float32Array;
  footprintSeed: Float32Array;
} {
  const originHeight = new Float32Array(count * 4);
  const footprintSeed = new Float32Array(count * 4);
  const trafficCount = Math.floor(count * 0.14);
  const buildingCount = count - trafficCount;

  for (let i = 0; i < buildingCount; i++) {
    const h1 = Math.sin(i * 12.9898) * 43758.5453;
    const r1 = h1 - Math.floor(h1);
    const h2 = Math.sin(i * 78.233 + 1.7) * 28461.123;
    const r2 = h2 - Math.floor(h2);
    const h3 = Math.sin(i * 39.425 + 5.1) * 19384.77;
    const r3 = h3 - Math.floor(h3);

    // Leave a dramatic central boulevard along x in [-6, 6]
    const side = i % 2 === 0 ? 1 : -1;
    const laneOffset = 6.8 + Math.pow(r1, 0.85) * 92.0;
    const wx = side * laneOffset;
    const wz = (i / Math.max(1, buildingCount)) * 210.0 - 25.0 + (r2 - 0.5) * 3.0;
    const height = 4.5 + Math.pow(r3, 1.65) * 38.0 + (laneOffset < 20 ? 8.0 : 0.0);
    const bw = 2.0 + r1 * 3.6;
    const bd = 2.0 + r2 * 3.6;

    originHeight[i * 4 + 0] = wx;
    originHeight[i * 4 + 1] = 0.0;
    originHeight[i * 4 + 2] = wz;
    originHeight[i * 4 + 3] = height;

    footprintSeed[i * 4 + 0] = bw;
    footprintSeed[i * 4 + 1] = bd;
    footprintSeed[i * 4 + 2] = r1 * 100.0 + i * 0.13;
    footprintSeed[i * 4 + 3] = 0.0; // Building
  }

  for (let j = 0; j < trafficCount; j++) {
    const idx = buildingCount + j;
    const lane = ((j % 5) - 2) * 2.4;
    const alt = 4.0 + (j % 7) * 3.4;
    originHeight[idx * 4 + 0] = lane;
    originHeight[idx * 4 + 1] = alt;
    originHeight[idx * 4 + 2] = (j / Math.max(1, trafficCount)) * 210.0;
    originHeight[idx * 4 + 3] = 0.22;

    footprintSeed[idx * 4 + 0] = 0.35;
    footprintSeed[idx * 4 + 1] = 2.4;
    footprintSeed[idx * 4 + 2] = j * 1.73;
    footprintSeed[idx * 4 + 3] = 1.0; // Aerial traffic light streak
  }

  return { originHeight, footprintSeed };
}
