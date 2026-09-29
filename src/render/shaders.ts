// GLSL sources. World coordinates: x right, y down; the water surface is y = 0.

const HEADER = /* glsl */ `#version 300 es
precision highp float;
`;

const COMMON = /* glsl */ `
uniform vec2 u_res;   // device pixels
uniform vec3 u_cam;   // camera centre (world) + zoom (device px per world unit)
vec4 toClip(vec2 w) {
  vec2 s = (w - u_cam.xy) * u_cam.z;
  return vec4(s.x / (u_res.x * 0.5), -s.y / (u_res.y * 0.5), 0.0, 1.0);
}
`;

const NOISE = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    a *= 0.5;
  }
  return s;
}
vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2));
}
vec3 viridis(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.2777, 0.0054, 0.3341);
  const vec3 c1 = vec3(0.1051, 1.4046, 1.3846);
  const vec3 c2 = vec3(-0.3309, 0.2148, 0.0951);
  const vec3 c3 = vec3(-4.6342, -5.7991, -19.3324);
  const vec3 c4 = vec3(6.2283, 14.1799, 56.6906);
  const vec3 c5 = vec3(4.7764, -13.7451, -65.3530);
  const vec3 c6 = vec3(-5.4355, 4.6459, 26.3124);
  return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
}
`;

// ---------------------------------------------------------------------------
// Background: sky, water column, seabed, vents, overlays
// ---------------------------------------------------------------------------

export const BG_VS = HEADER + COMMON + /* glsl */ `
in vec2 a_pos;
out vec2 v_world;
void main() {
  vec2 px = a_pos * 0.5 * u_res;
  v_world = u_cam.xy + vec2(px.x, -px.y) / u_cam.z;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const BG_FS = HEADER + NOISE + /* glsl */ `
in vec2 v_world;
out vec4 o;
uniform vec2 u_world;
uniform float u_sky;
uniform float u_time;
uniform float u_sun;
uniform float u_elev;
uniform float u_phase;
uniform float u_zoom;
uniform float u_wind;     // prevailing wind (signed)
uniform float u_storm;    // surface wind strength 0..~2 (waves)
uniform float u_sea;      // sea level (world y)
uniform vec2 u_grid;      // water grid top, height
uniform vec2 u_airGrid;   // air grid top, height
uniform sampler2D u_f0;   // temp, o2, co2, nut
uniform sampler2D u_f1;   // u, v, sulf, light
uniform sampler2D u_floor;
uniform sampler2D u_air;  // temp, humidity, cloud, rain
uniform sampler2D u_soil; // moisture, organic, snow, temp
uniform int u_overlay;
uniform vec4 u_vents[8];
uniform int u_nvents;
uniform vec2 u_bolt[10];
uniform int u_boltN;
uniform float u_boltGlow;

float floorY(float x) {
  return texture(u_floor, vec2(clamp(x / u_world.x, 0.0, 1.0), 0.5)).r * u_world.y;
}

float dayness() { return smoothstep(-0.25, 0.3, u_elev); }
float qsat(float T) { return 3.8 * exp(0.067 * clamp(T, -40.0, 45.0)); }

vec2 sunPos(float phase) {
  float el = -cos(phase * 6.28318);
  return vec2(u_world.x * (fract(phase - 0.25) * 2.0), u_sea - el * u_sky * 0.8 - 20.0);
}

vec3 sky(vec2 p) {
  float h = clamp((u_sea - p.y) / u_sky, 0.0, 1.0);
  float day = dayness();
  vec3 dayC = mix(vec3(0.63, 0.80, 0.93), vec3(0.17, 0.42, 0.78), pow(h, 0.7));
  vec3 nightC = mix(vec3(0.045, 0.065, 0.14), vec3(0.008, 0.012, 0.045), h);
  vec3 c = mix(nightC, dayC, day);
  float dusk = exp(-pow(u_elev * 3.2, 2.0));
  c += vec3(0.95, 0.42, 0.16) * dusk * pow(1.0 - h, 2.5) * 0.85;
  vec2 sp = sunPos(u_phase);
  float d = length(p - sp);
  float sunVis = smoothstep(-0.12, 0.02, u_elev);
  c += vec3(1.0, 0.92, 0.7) * (smoothstep(22.0, 18.0, d) * 2.2 + exp(-d / 80.0) * 0.55) * sunVis * clamp(u_sun, 0.2, 2.0);
  vec2 mp = sunPos(u_phase + 0.5);
  float md = length(p - mp);
  float moonVis = smoothstep(0.1, -0.2, u_elev);
  float crescent = smoothstep(13.0, 11.5, md) * (1.0 - smoothstep(13.0, 11.0, length(p - mp - vec2(5.0, -2.0))));
  c += vec3(0.85, 0.9, 1.0) * (crescent * 1.3 + exp(-md / 55.0) * 0.12) * moonVis;
  vec2 g = floor(p / 6.0);
  float r = hash12(g);
  if (r > 0.984) {
    vec2 sp2 = (g + 0.5 + (vec2(hash12(g + 3.1), hash12(g + 7.7)) - 0.5) * 0.7) * 6.0;
    float tw = 0.6 + 0.4 * sin(u_time * (1.0 + r * 3.0) + r * 50.0);
    c += vec3(0.9, 0.95, 1.0) * smoothstep(1.2, 0.0, length(p - sp2)) * (1.0 - day) * tw * h;
  }
  return c;
}

/** Clouds and rain from the air grid, with procedural detail drifting on the wind. */
vec3 weather(vec2 p, vec3 c, float groundY) {
  vec2 auv = vec2(p.x / u_world.x, (p.y - u_airGrid.x) / u_airGrid.y);
  if (auv.y < 0.0 || auv.y > 1.0) return c;
  vec4 a = texture(u_air, auv);
  float day = dayness();
  float dusk = exp(-pow(u_elev * 3.2, 2.0));
  // rain streaks below the clouds, slanted by the wind
  float rain = a.w;
  if (rain > 0.004 && p.y < groundY) {
    vec2 rp = vec2(p.x + (p.y - u_sea) * 0.35 * clamp(u_wind, -1.5, 1.5), p.y);
    float lane = floor(rp.x / 2.6);
    float rnd = hash12(vec2(lane, 7.0));
    float fy = fract(rp.y * 0.028 + u_time * (2.4 + rnd * 1.2) + rnd * 17.0);
    float drop = smoothstep(0.0, 0.04, fy) * (1.0 - smoothstep(0.04, 0.3, fy));
    float thin = 1.0 - smoothstep(0.08, 0.2, abs(fract(rp.x / 2.6) - 0.5));
    float amount = clamp(rain * 5.0, 0.0, 1.0) * step(0.35, rnd);
    c = mix(c, c * 0.8 + vec3(0.55, 0.6, 0.7) * (0.35 + 0.5 * day), drop * thin * amount * 0.55);
    c *= 1.0 - clamp(rain * 1.6, 0.0, 0.3);
  }
  float cw = a.z;
  if (cw < 0.004) return c;
  vec2 q = p * vec2(0.009, 0.016) + vec2(-u_time * 0.012 * u_wind, u_time * 0.002);
  float n = fbm(q);
  float n2 = fbm(q * 2.6 + 5.3);
  float dens = smoothstep(0.08, 0.55, cw * 1.25 + (n - 0.5) * 0.6 + (n2 - 0.5) * 0.25);
  if (dens <= 0.001) return c;
  float above = texture(u_air, auv - vec2(0.0, 0.07)).z;
  float thick = clamp(cw * 0.9, 0.0, 1.0);
  vec3 lit = mix(vec3(1.0, 0.99, 0.96), vec3(1.0, 0.7, 0.48), dusk) * (0.3 + 0.7 * day) + vec3(0.05, 0.06, 0.1) * (1.0 - day);
  vec3 shadow = mix(vec3(0.62, 0.65, 0.72), vec3(0.3, 0.32, 0.38), thick) * (0.25 + 0.75 * day);
  float selfShadow = clamp(above * 1.3 + thick * 0.55 - (n2 - 0.5) * 0.4, 0.0, 1.0);
  vec3 cc = mix(lit, shadow, selfShadow);
  return mix(c, cc, dens * 0.93);
}

float caustic(vec2 p, float t) {
  float c = 0.0;
  vec2 q = p;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    q = p + vec2(sin(t * 0.7 + fi * 2.1 + q.y * 0.9), cos(t * 0.6 - fi * 1.7 + q.x * 0.8));
    c += 1.0 / (1.0 + 18.0 * abs(sin(q.x + q.y * 0.6) * cos(q.y - q.x * 0.4)));
  }
  return pow(c / 3.0, 2.2);
}

vec3 water(vec2 p, float surf, float fy, vec4 f0, vec4 f1) {
  float depth = clamp((p.y - u_sea) / u_world.y, 0.0, 1.0);
  float day = dayness();
  float amb = 0.22 + 0.78 * day;
  vec3 shallow = vec3(0.08, 0.42, 0.52);
  vec3 mid = vec3(0.025, 0.18, 0.33);
  vec3 deep = vec3(0.006, 0.035, 0.085);
  vec3 c = mix(shallow, mid, smoothstep(0.0, 0.3, depth));
  c = mix(c, deep, smoothstep(0.25, 1.0, depth));
  float lf = clamp(f1.w / max(u_sun, 0.05), 0.0, 1.2);
  float shade = mix(0.72, 1.12, lf);
  c *= mix(0.55, 1.0, amb) * mix(1.0, shade, day);
  c += vec3(0.0, 0.01, 0.03) * (1.0 - day);
  // shallows over the beach take on the colour of the sand
  c = mix(c, vec3(0.45, 0.55, 0.45) * amb, exp(-(fy - p.y) / 9.0) * 0.45);

  float below = max(p.y - surf, 0.0);
  if (day > 0.01 && u_sun > 0.01) {
    if (below < 1100.0) {
      float slant = (u_phase - 0.5) * 0.9;
      float rx = p.x + p.y * slant;
      float rays = fbm(vec2(rx * 0.011, u_time * 0.045));
      rays = smoothstep(0.42, 0.85, rays) * exp(-below / 300.0) * u_sun * day * lf;
      c += vec3(0.3, 0.55, 0.55) * rays * 0.32;
    }
    if (below < 260.0) {
      float ca = caustic(p * 0.035, u_time * 0.9);
      c += vec3(0.35, 0.7, 0.7) * ca * exp(-below / 55.0) * u_sun * day * 0.3 * lf;
    }
  }
  vec2 vel = f1.xy;
  float ph = fract(u_time * 0.22);
  float ph2 = fract(u_time * 0.22 + 0.5);
  float n1 = vnoise((p - vel * ph * 5.0) * vec2(0.06, 0.09));
  float n2 = vnoise((p - vel * ph2 * 5.0) * vec2(0.06, 0.09) + 13.7);
  float fl = mix(n1, n2, abs(1.0 - 2.0 * ph));
  float spd = length(vel);
  c *= 1.0 + (fl - 0.5) * 0.18 * clamp(spd / 10.0, 0.15, 1.0);
  float temp = f0.x;
  float nut = f0.w;
  float sulf = f1.z;
  c = mix(c, c * vec3(0.85, 1.12, 0.8) + vec3(0.0, 0.015, 0.0), clamp(nut * 1.2, 0.0, 0.45));
  c = mix(c, vec3(0.3, 0.26, 0.1) * amb + 0.03, clamp(sulf * 0.045, 0.0, 0.5));
  c += vec3(1.0, 0.33, 0.07) * clamp((temp - 28.0) / 55.0, 0.0, 1.0) * 0.45;
  for (int L = 0; L < 2; L++) {
    float fl2 = float(L);
    float cs = 22.0 + fl2 * 13.0;
    vec2 q = p + vec2(sin(u_time * 0.1 + fl2) * 20.0, u_time * (2.0 + fl2 * 1.5));
    vec2 g = floor(q / cs);
    float r = hash12(g + fl2 * 31.0);
    if (r > 0.72) {
      vec2 mp = (g + vec2(hash12(g + 1.3), hash12(g + 5.1))) * cs;
      float md = length(q - mp);
      float sz = (0.5 + r) * 0.9;
      c += vec3(0.55, 0.75, 0.7) * smoothstep(sz, 0.0, md) * (0.12 + 0.35 * lf * day) * (1.0 - depth * 0.6);
    }
  }
  float sd = p.y - surf;
  c += vec3(0.6, 0.85, 0.9) * exp(-sd / 2.2) * (0.25 + 0.6 * day);
  // foam on stormy seas and in the surf zone
  float foam = smoothstep(0.55, 0.9, vnoise(vec2(p.x * 0.08 - u_time * 1.5, p.y * 0.3))) * exp(-sd / 3.0);
  c += vec3(0.8, 0.9, 0.95) * foam * (clamp(u_storm - 0.6, 0.0, 1.0) + exp(-(fy - surf) / 10.0)) * 0.6 * (0.3 + 0.7 * day);
  return c;
}

/** Rock strata underground, shared by the land and the seabed. */
vec3 strata(vec2 p, float d, vec3 top) {
  float n = fbm(p * vec2(0.03, 0.07));
  vec3 sub = mix(top, vec3(0.3, 0.25, 0.19) * (0.8 + 0.4 * n), smoothstep(3.0, 30.0, d));
  vec3 bed = vec3(0.22, 0.21, 0.22) * (0.7 + 0.6 * fbm(p * vec2(0.05, 0.12) + 3.0));
  float band = smoothstep(0.45, 0.55, fract((p.y + n * 60.0) / 70.0)) * 0.05;
  return mix(sub, bed + band, smoothstep(45.0, 140.0, d + n * 40.0));
}

vec3 seabed(vec2 p, float fy) {
  float d = p.y - fy;
  float day = dayness();
  float amb = 0.35 + 0.65 * day;
  float n = fbm(p * 0.06);
  float grain = hash12(floor(p * 1.3));
  vec3 top = vec3(0.3, 0.26, 0.19) * (0.72 + 0.4 * n + 0.1 * grain);
  float shore = smoothstep(90.0, 5.0, fy - u_sea);
  top = mix(top, vec3(0.62, 0.55, 0.4) * (0.85 + 0.3 * n), shore);
  top = mix(top, vec3(0.2, 0.22, 0.12), smoothstep(0.55, 0.75, fbm(p * vec2(0.03, 0.2))) * exp(-d / 8.0) * 0.6 * (1.0 - shore));
  float deepDim = mix(1.0, 0.5, smoothstep(0.0, 600.0, fy - u_sea));
  vec3 c = strata(p, d, top) * amb * deepDim;
  c += vec3(0.28, 0.25, 0.17) * exp(-d / 2.5) * 0.4 * amb * deepDim;
  return c;
}

/** Land: beach sand, topsoil (darker when wet, blacker with humus), bare rock up high, snow when freezing. */
vec3 land(vec2 p, float fy) {
  float d = p.y - fy;
  float elev = u_sea - fy;
  vec4 s = texture(u_soil, vec2(clamp(p.x / u_world.x, 0.0, 1.0), 0.5));
  float day = dayness();
  float amb = 0.35 + 0.65 * day;
  float n = fbm(p * 0.05);
  float grain = hash12(floor(p * 1.4));
  float wet = clamp(s.x, 0.0, 1.0);
  vec3 soil = mix(vec3(0.5, 0.39, 0.25), vec3(0.3, 0.22, 0.14), wet);
  soil = mix(soil, vec3(0.16, 0.14, 0.08), clamp(s.y * 0.1, 0.0, 0.6));
  vec3 sand = mix(vec3(0.8, 0.72, 0.52), vec3(0.58, 0.5, 0.36), wet);
  vec3 rock = vec3(0.46, 0.45, 0.47) * (0.85 + 0.3 * n);
  float sandy = 1.0 - smoothstep(10.0, 34.0, elev + n * 10.0);
  float rocky = smoothstep(170.0, 250.0, elev + n * 60.0);
  vec3 top = mix(mix(soil, sand, sandy), rock, rocky);
  // the soil's state only shows in a thin topsoil band; below is plain earth and rock
  vec3 earth = mix(vec3(0.36, 0.28, 0.19), rock * 0.8, rocky) * (0.85 + 0.3 * n);
  vec3 c = mix(top, earth, smoothstep(2.0, 11.0, d + n * 3.0));
  c = strata(p, d, c);
  c *= (0.85 + 0.25 * n + 0.07 * grain) * amb;
  float snow = clamp(s.z * 4.0 + smoothstep(1.5, -3.0, s.w) * smoothstep(120.0, 220.0, elev), 0.0, 1.0);
  c = mix(c, vec3(0.93, 0.96, 1.0) * (0.4 + 0.6 * amb), snow * (1.0 - smoothstep(2.0, 8.0, d + n * 4.0)));
  c += vec3(0.25, 0.22, 0.16) * exp(-d / 1.6) * 0.35 * amb;
  return c;
}

vec3 ventLayer(vec2 p, vec3 c) {
  for (int i = 0; i < 8; i++) {
    if (i >= u_nvents) break;
    vec4 v = u_vents[i];
    vec2 q = p - v.xy;
    float pw = v.z;
    if (abs(q.x) > 220.0 || q.y < -700.0 || q.y > 40.0) continue;
    float hgt = 36.0;
    float t = clamp(-q.y / hgt, 0.0, 1.0);
    float halfW = mix(22.0, 7.0, t);
    float inside = step(-hgt, q.y) * smoothstep(halfW + 1.0, halfW - 1.0, abs(q.x)) * step(q.y, 30.0);
    if (inside > 0.0) {
      float n = fbm(p * 0.2);
      vec3 rock = vec3(0.13, 0.11, 0.1) * (0.6 + 0.6 * n);
      float crack = smoothstep(0.62, 0.7, fbm(p * vec2(0.25, 0.08) + 3.0)) * pw;
      rock += vec3(1.0, 0.4, 0.08) * crack * (0.8 + 0.4 * sin(u_time * 2.0 + p.y * 0.2));
      rock += vec3(1.0, 0.5, 0.15) * exp(-length(q + vec2(0.0, hgt)) / 6.0) * 1.5 * pw;
      c = mix(c, rock, inside);
    }
    float up = -(q.y + hgt);
    if (up > 0.0 && p.y > u_sea) {
      float spread = 5.0 + up * 0.14;
      float wob = sin(up * 0.05 - u_time * 1.5) * up * 0.03;
      float plume = exp(-abs(q.x - wob) / spread) * exp(-up / 180.0);
      float flick = 0.7 + 0.3 * vnoise(vec2(q.x * 0.1, up * 0.05 - u_time * 2.0));
      c += vec3(1.0, 0.45, 0.15) * plume * flick * 0.35 * pw;
      c = mix(c, c * vec3(0.9, 0.85, 0.7), plume * 0.3);
      for (int k = 0; k < 7; k++) {
        float fk = float(k);
        float life = fract(u_time * (0.12 + 0.03 * fk) + fk * 0.137);
        float by = life * 320.0;
        float bx = sin(u_time * 1.3 + fk * 1.7 + by * 0.04) * (3.0 + by * 0.05);
        float br = 1.2 + mod(fk, 3.0) * 0.6;
        float bd = length(vec2(q.x - bx, up - by)) - br;
        c += vec3(0.7, 0.9, 1.0) * smoothstep(0.7, 0.0, abs(bd)) * 0.7 * (1.0 - life) * pw;
      }
    }
  }
  return c;
}

vec3 overlayWater(vec3 c, vec4 f0, vec4 f1) {
  if (u_overlay == 0) return c;
  float x = 0.0;
  vec3 m;
  if (u_overlay == 1) { x = f0.x / 40.0; m = turbo(x); }
  else if (u_overlay == 2) { x = f0.y / 12.0; m = viridis(x); }
  else if (u_overlay == 3) { x = f0.z / 30.0; m = viridis(x); }
  else if (u_overlay == 4) { x = sqrt(f0.w / 0.6); m = viridis(x); }
  else if (u_overlay == 5) { x = sqrt(f1.z / 12.0); m = turbo(x * 0.9 + 0.05); }
  else if (u_overlay == 6) { x = f1.w; m = mix(vec3(0.02), vec3(1.0, 0.95, 0.6), clamp(x, 0.0, 1.0)); }
  else if (u_overlay == 7) { x = length(f1.xy) / 25.0; m = turbo(x * 0.85 + 0.05); }
  else return c;
  return mix(c, m * 0.9, 0.62);
}

vec3 overlayAir(vec3 c, vec2 p) {
  if (u_overlay != 1 && u_overlay != 8) return c;
  vec2 auv = vec2(p.x / u_world.x, (p.y - u_airGrid.x) / u_airGrid.y);
  if (auv.y < 0.0 || auv.y > 1.0) return c;
  vec4 a = texture(u_air, auv);
  vec3 m = u_overlay == 1 ? turbo((a.x + 10.0) / 50.0) : viridis(clamp(a.y / qsat(a.x), 0.0, 1.0));
  return mix(c, m * 0.9, 0.55);
}

vec3 overlayLand(vec3 c, vec2 p) {
  if (u_overlay != 1 && u_overlay != 8) return c;
  vec4 s = texture(u_soil, vec2(clamp(p.x / u_world.x, 0.0, 1.0), 0.5));
  vec3 m = u_overlay == 1 ? turbo((s.w + 10.0) / 50.0) : viridis(clamp(s.x, 0.0, 1.0));
  return mix(c, m * 0.9, 0.55);
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  vec2 p = v_world;
  float fy = floorY(p.x);
  float waves = (2.4 * sin(p.x * 0.021 + u_time * 1.1) + 1.5 * sin(p.x * 0.047 - u_time * 1.7) + 0.7 * sin(p.x * 0.11 + u_time * 2.3)) * (0.6 + u_storm * 1.2);
  float surf = u_sea + waves;
  vec3 c;
  bool outside = p.x < 0.0 || p.x > u_world.x;
  if (p.y > fy) {
    // blend land and seabed shading across the shoreline so there is no seam
    float shoreMix = smoothstep(-2.0, 30.0, fy - u_sea);
    if (shoreMix <= 0.0) c = overlayLand(land(p, fy), p);
    else if (shoreMix >= 1.0) c = seabed(p, fy);
    else c = mix(overlayLand(land(p, fy), p), seabed(p, fy), shoreMix);
    c = ventLayer(p, c);
  } else if (p.y > surf) {
    vec2 uv = vec2(p.x / u_world.x, (p.y - u_grid.x) / u_grid.y);
    vec4 f0 = texture(u_f0, uv);
    vec4 f1 = texture(u_f1, uv);
    c = overlayWater(water(p, surf, fy, f0, f1), f0, f1);
    c = ventLayer(p, c);
  } else {
    c = sky(p);
    c = weather(p, c, min(fy, surf));
    c = overlayAir(c, p);
    c += vec3(0.5, 0.55, 0.7) * u_boltGlow * 0.45;
  }
  if (u_boltN > 1) {
    float d = 1e9;
    for (int k = 0; k < 9; k++) {
      if (k >= u_boltN - 1) break;
      d = min(d, segDist(p, u_bolt[k], u_bolt[k + 1]));
    }
    float px = 1.0 / max(u_zoom, 0.1);
    float core = smoothstep(1.4 * px + 0.6, 0.0, d);
    c += vec3(0.9, 0.92, 1.0) * (core * 4.0 + exp(-d / 7.0) * 0.9 + exp(-d / 40.0) * 0.25) * u_boltGlow;
  }
  if (outside) {
    float e = p.x < 0.0 ? -p.x : p.x - u_world.x;
    vec3 wall = vec3(0.05, 0.05, 0.06) * (0.7 + 0.5 * fbm(p * 0.03));
    c = mix(c, wall, smoothstep(0.0, 6.0, e));
  }
  o = vec4(c, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Rocks
// ---------------------------------------------------------------------------

export const ROCK_VS = HEADER + COMMON + /* glsl */ `
in vec2 a_quad;
in vec4 a_rock;  // x, y, r, seed
in vec4 a_col;   // rgb, selected
out vec2 v_p;
out vec2 v_world;
flat out vec4 v_col;
flat out float v_seed;
flat out float v_aa;
void main() {
  vec2 local = a_quad * 1.08;
  vec2 w = a_rock.xy + local * a_rock.z;
  v_p = local;
  v_world = w;
  v_col = a_col;
  v_seed = a_rock.w;
  v_aa = 1.5 / (a_rock.z * u_cam.z);
  gl_Position = toClip(w);
}
`;

export const ROCK_FS = HEADER + NOISE + /* glsl */ `
in vec2 v_p;
in vec2 v_world;
flat in vec4 v_col;
flat in float v_seed;
flat in float v_aa;
out vec4 o;
uniform float u_ambient;
uniform float u_worldH;
uniform float u_time;
float radiusAt(float a, float s) {
  return 0.86 + 0.06 * sin(3.0 * a + s) + 0.045 * sin(5.0 * a + s * 1.7) + 0.025 * sin(9.0 * a + s * 2.3) + 0.012 * sin(17.0 * a + s * 3.1);
}
void main() {
  float len = length(v_p);
  float a = atan(v_p.y, v_p.x);
  float R = radiusAt(a, v_seed);
  float d = len - R;
  float alpha = smoothstep(v_aa, -v_aa, d);
  if (alpha <= 0.001) discard;
  float rl = len / R;
  float h = sqrt(max(0.0, 1.0 - rl * rl));
  vec3 n = normalize(vec3(v_p / R * 0.9, h + 0.2));
  vec3 L = normalize(vec3(-0.3, -0.75, 0.6));
  float diff = max(0.0, dot(n, L));
  float tex = fbm(v_p * 4.5 + v_seed);
  float strata = sin((v_p.y + tex * 0.35) * 16.0 + v_seed) * 0.5 + 0.5;
  vec3 base = v_col.rgb * (0.75 + 0.45 * tex) * (0.9 + 0.1 * strata);
  float speck = step(0.93, hash12(floor(v_p * 40.0 + v_seed)));
  base += speck * 0.08;
  float depthDim = mix(1.0, 0.6, clamp(v_world.y / u_worldH, 0.0, 1.0));
  vec3 c = base * (0.28 + 0.95 * diff) * depthDim * mix(0.45, 1.0, u_ambient);
  float top = smoothstep(0.1, 0.7, -n.y);
  c = mix(c, c * vec3(0.7, 1.15, 0.7) + vec3(0.0, 0.025, 0.0), top * 0.35 * (1.0 - clamp(v_world.y / u_worldH, 0.0, 1.0)));
  c *= 0.62 + 0.38 * smoothstep(0.0, -0.1, d);
  if (v_col.a > 0.5) c += vec3(0.4, 0.9, 1.0) * smoothstep(0.06, 0.0, abs(d + 0.03)) * (1.2 + 0.4 * sin(u_time * 4.0));
  o = vec4(c * alpha, alpha);
}
`;

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export const CELL_VS = HEADER + COMMON + /* glsl */ `
in vec2 a_quad;
in vec4 a_pr;    // x, y, r, heading
in vec4 a_look;  // hue, energy, thrust, glow
in vec4 a_al1;   // chloro, chemo, mouth, flagella
in vec4 a_al2;   // armor, sensor, vacuole, storage
in vec4 a_misc;  // seed, flags, health, inflate
in vec4 a_ext;   // roots/cuticle, hydration, on land, -
out vec2 v_p;
flat out vec4 v_look;
flat out vec4 v_al1;
flat out vec4 v_al2;
flat out vec4 v_misc;
flat out vec4 v_ext;
flat out float v_aa;
void main() {
  float r = max(a_pr.z, 2.2 / u_cam.z);
  float tail = 1.0 + 0.8 + 2.3 * a_al1.w;
  float ext = max(max(1.6 + 0.9 * a_look.w, a_al1.w > 0.03 ? tail : 1.5), 1.55 + 0.45 * a_al2.y);
  vec2 local = a_quad * ext;
  float h = a_pr.w;
  vec2 fw = vec2(cos(h), sin(h));
  vec2 sd = vec2(-sin(h), cos(h));
  vec2 w = a_pr.xy + (fw * local.x + sd * local.y) * r;
  v_p = local;
  v_look = a_look;
  v_al1 = a_al1;
  v_al2 = a_al2;
  v_misc = a_misc;
  v_ext = a_ext;
  v_aa = 1.2 / (r * u_cam.z);
  gl_Position = toClip(w);
}
`;

export const CELL_FS = HEADER + /* glsl */ `
in vec2 v_p;
flat in vec4 v_look;
flat in vec4 v_al1;
flat in vec4 v_al2;
flat in vec4 v_misc;
flat in vec4 v_ext;
flat in float v_aa;
out vec4 o;
uniform float u_time;
uniform float u_ambient;

vec3 hsv(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(0.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float h11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void over(inout vec4 dst, vec3 c, float a) {
  dst.rgb = c * a + dst.rgb * (1.0 - a);
  dst.a = a + dst.a * (1.0 - a);
}

void main() {
  vec2 p = v_p;
  float hue = v_look.x, energy = v_look.y, thrust = v_look.z, glow = v_look.w;
  float chloro = v_al1.x, chemo = v_al1.y, mouth = v_al1.z, flag = v_al1.w;
  float armor = v_al2.x, sensor = v_al2.y, vac = v_al2.z, stor = v_al2.w;
  float seed = v_misc.x, flags = v_misc.y, health = v_misc.z, inflate = v_misc.w;
  bool selected = mod(flags, 2.0) >= 1.0;
  bool eating = mod(floor(flags / 2.0), 2.0) >= 1.0;
  bool marked = flags >= 4.0;
  float t = u_time + seed * 37.0;
  float aa = v_aa;
  float len = length(p);
  float ang = atan(p.y, p.x);

  float shrivel = clamp(1.0 - v_ext.y * 1.5, 0.0, 1.0);
  float rr = 1.0 + (0.04 * sin(ang * 5.0 + t * 1.6) + 0.025 * sin(ang * 3.0 - t * 1.1 + seed * 9.0)) * (1.0 - shrivel)
           - shrivel * 0.08 * (0.5 + 0.5 * sin(ang * 7.0 + seed * 20.0));
  float mo = mouth * (eating ? 1.0 : 0.4);
  rr -= mo * 0.34 * exp(-ang * ang * 9.0 / (0.35 + mo));
  float d = len - rr;

  vec3 pig = hsv(vec3(hue, 0.5, 1.0));
  float ts = chloro + chemo + mouth;
  vec3 troph = (chloro * vec3(0.35, 0.95, 0.4) + chemo * vec3(1.0, 0.62, 0.2) + mouth * vec3(1.0, 0.35, 0.45)) / max(ts, 1e-3);
  vec3 base = mix(pig, troph, clamp(ts * 1.3, 0.0, 0.62));
  float root = v_ext.x;
  float hydration = v_ext.y;
  // root cells are earthy brown
  base = mix(base, vec3(0.62, 0.45, 0.28), clamp(root * 1.1, 0.0, 0.85));
  float vit = mix(0.45, 1.0, clamp(energy * 1.6, 0.0, 1.0));
  base = mix(vec3(dot(base, vec3(0.3, 0.5, 0.2))), base, 0.35 + 0.65 * health) * vit;
  // drying out: dull and shrivelled
  base = mix(vec3(dot(base, vec3(0.3, 0.5, 0.2))) * vec3(0.9, 0.85, 0.7), base, clamp(hydration * 1.6 - 0.2, 0.0, 1.0));

  vec4 col = vec4(0.0);

  // flagellum
  if (flag > 0.03) {
    float L = 0.8 + 2.3 * flag;
    float x = -p.x - 0.9;
    if (x > -0.15 && x < L) {
      float e = clamp(x / L, 0.0, 1.0);
      float wave = sin(x * 6.0 - t * (6.0 + 16.0 * thrust)) * (0.1 + 0.2 * e) * (0.45 + thrust);
      float dist = abs(p.y - wave);
      float wdt = mix(0.09, 0.03, e) + aa;
      float a = smoothstep(wdt, wdt - aa * 1.5 - 0.01, dist) * (1.0 - smoothstep(0.75 * L, L, x)) * smoothstep(-0.15, 0.05, x);
      over(col, base * 0.85 + 0.08, a * 0.9);
    }
  }
  // sensory cilia
  if (sensor > 0.04) {
    float k = floor(10.0 + sensor * 30.0);
    float sa = fract(ang / 6.28318 * k + sin(t * 2.0 + ang * 3.0) * 0.06);
    float arc = abs(sa - 0.5) * 6.28318 / k * len;
    float hl = 0.1 + 0.32 * sensor;
    float a = smoothstep(0.03 + aa, 0.0, arc) * step(rr - 0.02, len) * (1.0 - smoothstep(rr + hl * 0.6, rr + hl, len));
    over(col, base * 0.9 + 0.1, a * 0.65);
  }

  // root hairs
  if (v_ext.x > 0.4) {
    float k = 14.0;
    float sa = fract(ang / 6.28318 * k + seed * 3.0);
    float arc = abs(sa - 0.5) * 6.28318 / k * len;
    float hl = 0.35 + 0.35 * h11(floor(ang / 6.28318 * k + seed * 3.0) + seed);
    float a = smoothstep(0.022 + aa, 0.0, arc) * step(rr - 0.02, len) * (1.0 - smoothstep(rr + hl * 0.7, rr + hl, len));
    over(col, vec3(0.7, 0.55, 0.36) * vit, a * 0.75);
  }
  float inside = smoothstep(aa, -aa, d);
  if (inside > 0.0) {
    vec3 c = base * 0.26 + vec3(0.02, 0.03, 0.04);
    float a = 0.58 + 0.12 * armor;
    c += base * 0.28 * smoothstep(-0.5, 0.0, d);
    float nOrg = chloro + chemo + stor;
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      if (fi >= nOrg * 16.0) break;
      float r1 = h11(seed * 91.7 + fi * 13.3);
      float r2 = h11(seed * 47.1 + fi * 7.9);
      float r3 = h11(seed * 17.3 + fi * 3.7);
      float oa = r1 * 6.28318 + t * 0.15 * (r3 - 0.5);
      vec2 op = vec2(cos(oa), sin(oa)) * sqrt(r2) * 0.58;
      float pick = r3 * (nOrg + 1e-4);
      vec3 oc;
      float osz;
      if (pick < chloro) { oc = vec3(0.3, 1.0, 0.35); osz = 0.14; }
      else if (pick < chloro + chemo) { oc = vec3(1.0, 0.6, 0.15); osz = 0.11; }
      else { oc = vec3(1.0, 0.92, 0.55); osz = 0.08 + stor * 0.12; }
      float od = length((p - op) * vec2(1.0, 1.35));
      float b = smoothstep(osz, osz * 0.35, od);
      c = mix(c, oc * 0.85 * vit, b * 0.85);
      a = max(a, b * 0.92);
    }
    if (vac > 0.03) {
      vec2 vp = vec2(-0.28, -0.22);
      float vr = 0.1 + 0.34 * vac * (0.4 + 0.6 * inflate);
      float vd = length(p - vp) - vr;
      c = mix(c, vec3(0.7, 0.9, 1.0) * 0.45, smoothstep(0.02, -0.02, vd) * 0.55);
      c += vec3(0.6, 0.85, 1.0) * smoothstep(0.05, 0.0, abs(vd)) * 0.45;
    }
    vec2 np = vec2(-0.1, 0.18) + 0.03 * vec2(sin(t * 0.7), cos(t * 0.5));
    float nd = length(p - np) - 0.2;
    c = mix(c, vec3(0.45, 0.28, 0.72) * vit, smoothstep(0.02, -0.02, nd) * 0.9);
    c += vec3(0.75, 0.55, 1.0) * smoothstep(0.035, 0.0, abs(nd)) * 0.35;
    c = mix(c, vec3(0.8, 0.6, 1.0), smoothstep(0.06, 0.03, length(p - np - vec2(0.05, -0.04))) * 0.6);
    if (sensor > 0.08) {
      float ed = length(p - vec2(0.6, -0.32)) - (0.06 + 0.09 * sensor);
      c = mix(c, vec3(1.0, 0.16, 0.1), smoothstep(0.02, -0.02, ed));
    }
    over(col, c, a * inside);
  }

  // membrane
  float mw = 0.05 + armor * 0.22;
  float mem = smoothstep(mw + aa, mw * 0.3, abs(d + mw * 0.5));
  vec3 mc = mix(base * 1.25 + 0.08, vec3(0.55, 0.45, 0.35) * vit, clamp(armor * 1.5, 0.0, 0.8));
  // a waxy cuticle glints gold
  mc = mix(mc, vec3(0.95, 0.82, 0.45) * vit, clamp(root * 1.5, 0.0, 0.5) * (1.0 - clamp(root - 0.6, 0.0, 1.0)));
  over(col, mc, mem * 0.95);
  if (mouth > 0.1) {
    float fwd = exp(-ang * ang * 14.0);
    over(col, vec3(1.0, 0.45, 0.5) * vit * (eating ? 1.3 : 0.9), fwd * mem * min(1.0, mouth * 2.0));
  }
  // when a cell is only a few pixels wide, draw it as a solid glowing dot so it reads as life
  float pxR = 1.2 / aa;
  float small = smoothstep(7.0, 2.5, pxR);
  if (small > 0.0) {
    float dotA = smoothstep(1.0 + aa, 1.0 - aa * 2.0, len);
    vec4 dotC = vec4(base * 1.05 + 0.06, 1.0) * dotA;
    col = mix(col, dotC, small);
  }
  col.rgb *= mix(0.6, 1.0, u_ambient);
  // buried: seen through the soil
  if (v_ext.w > 0.5) col *= vec4(vec3(0.75, 0.62, 0.48), 0.7);

  if (glow > 0.02) col.rgb += (base * 1.4 + 0.25) * glow * exp(-max(d, 0.0) * 3.5) * 0.9 * (1.0 - inside * 0.4);
  if (selected) {
    float sr = abs(len - (1.5 + 0.06 * sin(u_time * 4.0)));
    float ring = smoothstep(0.07 + aa, 0.0, sr);
    col += vec4(vec3(0.5, 1.0, 1.0) * 1.8, 1.0) * ring;
  } else if (marked) {
    float sr = abs(len - 1.45);
    col += vec4(vec3(1.0, 0.9, 0.4), 1.0) * smoothstep(0.08 + aa, 0.0, sr) * 0.8;
  }
  o = col;
}
`;

// ---------------------------------------------------------------------------
// Sprites: detritus, rings, brush cursor
// ---------------------------------------------------------------------------

export const SPRITE_VS = HEADER + COMMON + /* glsl */ `
in vec2 a_quad;
in vec4 a_s;    // x, y, size (world), kind
in vec4 a_c;    // rgba
out vec2 v_p;
flat out vec4 v_s;
flat out vec4 v_c;
flat out float v_px;
void main() {
  float kind = a_s.w;
  float size = kind < 0.5 ? max(a_s.z, 1.3 / u_cam.z) : a_s.z;
  float ext = kind < 0.5 ? 1.8 : kind > 2.5 ? 1.05 : 1.15;
  vec2 w = a_s.xy + a_quad * size * ext;
  v_p = a_quad * ext;
  v_s = vec4(a_s.xy, size, kind);
  v_c = a_c;
  v_px = 1.0 / (size * u_cam.z);
  gl_Position = toClip(w);
}
`;

export const SPRITE_FS = HEADER + /* glsl */ `
in vec2 v_p;
flat in vec4 v_s;
flat in vec4 v_c;
flat in float v_px;
out vec4 o;
uniform float u_time;
void main() {
  float len = length(v_p);
  float kind = v_s.w;
  if (kind < 0.5) {
    float core = smoothstep(1.0, 0.2, len);
    float halo = exp(-len * 2.5) * 0.35;
    float a = clamp(core + halo, 0.0, 1.0) * v_c.a;
    o = vec4(v_c.rgb * a, a * 0.9);
  } else if (kind > 2.5) {
    // soft membrane glow (colony matrix)
    float a = smoothstep(1.0, 0.55, len) * v_c.a;
    o = vec4(v_c.rgb * a * 0.6, a * 0.5);
  } else if (kind < 1.5) {
    float w = 2.0 * v_px;
    float ring = smoothstep(w, 0.0, abs(len - 1.0));
    float pulse = 0.85 + 0.15 * sin(u_time * 4.0);
    o = vec4(v_c.rgb * ring * pulse, ring * v_c.a);
  } else {
    float w = 1.5 * v_px;
    float ang = atan(v_p.y, v_p.x);
    float dash = step(0.5, fract(ang * 6.0 + u_time * 0.5));
    float ring = smoothstep(w, 0.0, abs(len - 1.0)) * (0.35 + 0.65 * dash);
    float fill = step(len, 1.0) * 0.06;
    o = vec4(v_c.rgb * (ring + fill), (ring + fill) * v_c.a);
  }
}
`;

// ---------------------------------------------------------------------------
// Post-processing
// ---------------------------------------------------------------------------

export const POST_VS = HEADER + /* glsl */ `
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

export const EXTRACT_FS = HEADER + /* glsl */ `
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_texel;
void main() {
  vec3 c = vec3(0.0);
  c += texture(u_tex, v_uv + u_texel * vec2(-1.0, -1.0)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(1.0, -1.0)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(-1.0, 1.0)).rgb;
  c += texture(u_tex, v_uv + u_texel * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float l = max(c.r, max(c.g, c.b));
  float k = smoothstep(0.62, 1.25, l);
  o = vec4(c * k, 1.0);
}
`;

export const BLUR_FS = HEADER + /* glsl */ `
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_tex;
uniform vec2 u_dir;
void main() {
  vec3 c = texture(u_tex, v_uv).rgb * 0.2270270270;
  c += texture(u_tex, v_uv + u_dir * 1.3846153846).rgb * 0.3162162162;
  c += texture(u_tex, v_uv - u_dir * 1.3846153846).rgb * 0.3162162162;
  c += texture(u_tex, v_uv + u_dir * 3.2307692308).rgb * 0.0702702703;
  c += texture(u_tex, v_uv - u_dir * 3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0);
}
`;

export const COMPOSITE_FS = HEADER + /* glsl */ `
in vec2 v_uv;
out vec4 o;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform float u_bloomK;
uniform float u_time;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 shoulder(vec3 c) {
  vec3 over = max(c - 0.8, 0.0);
  return min(c, vec3(0.8)) + 0.2 * (1.0 - exp(-over / 0.2 * 1.0));
}
void main() {
  vec3 c = texture(u_scene, v_uv).rgb;
  vec3 b = texture(u_bloom, v_uv).rgb;
  c += b * u_bloomK;
  c = shoulder(c);
  vec2 q = v_uv - 0.5;
  c *= 1.0 - dot(q, q) * 0.55;
  c += (hash(v_uv * 1000.0 + fract(u_time)) - 0.5) * 0.012;
  o = vec4(c, 1.0);
}
`;
