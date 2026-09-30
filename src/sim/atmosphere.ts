import { AIR, AIR_CELL, AIR_NX, AIR_NY, AIR_TOP, GodParams, WORLD_W } from './params';
import { Rng } from './rng';
import { Terrain } from './terrain';
import { f32, i16, i32, u8 } from './shared';

// Grid size, bound when an Atmosphere is created (the world width is chosen per world).
let N = 0;
let NA = 0;
let DUMMY = 0;
function bindGrid(): number {
  N = AIR_NX * AIR_NY;
  NA = N + 1;
  DUMMY = N;
  return N;
}

/** Saturation vapour (g/kg) at temperature T (°C) — Clausius-Clapeyron-like. */
export const qsat = (T: number) => 3.8 * Math.exp(0.067 * Math.max(-40, Math.min(45, T)));

export const airRowY = (j: number) => AIR_TOP + (j + 0.5) * AIR_CELL;
export const airColX = (i: number) => (i + 0.5) * AIR_CELL;

export interface Bolt {
  pts: number[]; // x0, y0, x1, y1, …
  age: number;
  x: number;
  y: number;
}

/**
 * The air: a coarse incompressible flow with temperature, water vapour and cloud water.
 * Warm air rises, rising air cools, vapour condenses into cloud (releasing heat), cloud rains out.
 */
export class Atmosphere {
  /** Number of air cells (binds the module's grid size first, so it must stay the first field). */
  readonly size = bindGrid();
  u = f32(NA);
  v = f32(NA);
  temp = f32(NA);
  hum = f32(NA);
  cloud = f32(NA);
  /** 1 where the cell is air (above the ground and the sea). */
  air = u8(N);
  /** Lowest air row per column. */
  groundRow = i16(AIR_NX);
  /** World y of the ground or sea surface under each column. */
  surfaceY = f32(AIR_NX);
  /** Ground / sea-surface temperature under each column (set from the sea and the soil). */
  surfaceT = f32(AIR_NX).fill(15);
  /** 1 over open sea. */
  overSea = u8(AIR_NX);
  /** Rain reaching the ground (smoothed rate, per second) and in the last step. */
  rain = f32(AIR_NX);
  rainStep = f32(AIR_NX);
  /** Fraction of sunlight blocked by clouds in each column. */
  shade = f32(AIR_NX);
  /** Vapour taken up from the surface in the last step (for the soil budget). */
  evap = f32(AIR_NX);
  bolt: Bolt | null = null;
  /** Sea-level air temperature set by the climate and the sun (the free atmosphere relaxes to it). */
  climateT = 15;
  weatherPhase = 0;
  stormTimer = 60;

  private bu = f32(NA);
  private bv = f32(NA);
  private bt = f32(NA);
  private bh = f32(NA);
  private bc = f32(NA);
  private p = f32(NA);
  private div = f32(N);
  private nbR = i32(N);
  private nbL = i32(N);
  private nbD = i32(N);
  private nbU = i32(N);
  private nbInv = f32(N);
  private list = i32(N);
  private nAir = 0;
  private maskKey = '';

  init(t: Terrain, seaLevel: number, baseT: number) {
    this.rebuild(t, seaLevel, true);
    for (let j = 0; j < AIR_NY; j++) {
      for (let i = 0; i < AIR_NX; i++) {
        const idx = j * AIR_NX + i;
        const alt = this.surfaceY[i] - airRowY(j);
        this.temp[idx] = baseT - AIR.LAPSE * Math.max(0, alt);
        this.hum[idx] = qsat(this.temp[idx]) * 0.55;
      }
    }
  }

  /** Recompute which cells are air (the ground and the tide change it). */
  rebuild(t: Terrain, seaLevel: number, force = false) {
    let key = '';
    for (let i = 0; i < AIR_NX; i++) {
      const x = airColX(i);
      // the surface is the lower of ground and sea across the column
      let sy = Math.min(seaLevel, t.floorY(x));
      sy = Math.min(sy, Math.min(seaLevel, t.floorY(x - AIR_CELL * 0.4)), Math.min(seaLevel, t.floorY(x + AIR_CELL * 0.4)));
      this.surfaceY[i] = sy;
      this.overSea[i] = t.floorY(x) > seaLevel + 4 ? 1 : 0;
      let gr = -1;
      for (let j = 0; j < AIR_NY; j++) {
        const a = airRowY(j) < sy ? 1 : 0;
        this.air[j * AIR_NX + i] = a;
        if (a) gr = j;
      }
      this.groundRow[i] = gr;
      key += gr + ',';
    }
    if (!force && key === this.maskKey) return;
    this.maskKey = key;
    let k = 0;
    const { air, nbR, nbL, nbD, nbU, nbInv, list } = this;
    for (let j = 0; j < AIR_NY; j++) {
      for (let i = 0; i < AIR_NX; i++) {
        const idx = j * AIR_NX + i;
        if (!air[idx]) {
          this.u[idx] = 0;
          this.v[idx] = 0;
        }
        const r = i < AIR_NX - 1 && air[idx + 1] ? idx + 1 : DUMMY;
        const l = i > 0 && air[idx - 1] ? idx - 1 : DUMMY;
        const d = j < AIR_NY - 1 && air[idx + AIR_NX] ? idx + AIR_NX : DUMMY;
        const u = j > 0 && air[idx - AIR_NX] ? idx - AIR_NX : DUMMY;
        nbR[idx] = r;
        nbL[idx] = l;
        nbD[idx] = d;
        nbU[idx] = u;
        const cnt = (r !== DUMMY ? 1 : 0) + (l !== DUMMY ? 1 : 0) + (d !== DUMMY ? 1 : 0) + (u !== DUMMY ? 1 : 0);
        nbInv[idx] = cnt ? 1 / cnt : 0;
        if (air[idx]) list[k++] = idx;
      }
    }
    this.nAir = k;
  }

  cellIndex(x: number, y: number): number {
    let i = (x / AIR_CELL) | 0;
    let j = ((y - AIR_TOP) / AIR_CELL) | 0;
    if (i < 0) i = 0;
    else if (i >= AIR_NX) i = AIR_NX - 1;
    if (j < 0) j = 0;
    else if (j >= AIR_NY) j = AIR_NY - 1;
    return j * AIR_NX + i;
  }

  column(x: number): number {
    const i = (x / AIR_CELL) | 0;
    return i < 0 ? 0 : i >= AIR_NX ? AIR_NX - 1 : i;
  }

  /** Air cell just above the ground in column i. */
  groundCell(i: number): number {
    const j = this.groundRow[i];
    return j < 0 ? -1 : j * AIR_NX + i;
  }

  /** Wind just above the ground/sea at x. */
  surfaceWind(x: number): number {
    const c = this.groundCell(this.column(x));
    return c < 0 ? 0 : this.u[c];
  }

  /** Air temperature just above the ground/sea at x. */
  surfaceAirT(x: number): number {
    const c = this.groundCell(this.column(x));
    return c < 0 ? this.surfaceT[this.column(x)] : this.temp[c];
  }

  /** Add vapour to the lowest air cell of a column. */
  addVapour(i: number, amount: number) {
    const c = this.groundCell(i);
    if (c >= 0) this.hum[c] += amount;
  }

  /** Prevailing wind direction/strength pattern (slowly changing weather). */
  prevailing(P: GodParams): number {
    const ph = this.weatherPhase;
    return P.wind * (0.75 * Math.sin(ph) + 0.35 * Math.sin(ph * 2.3 + 1.2));
  }

  step(dt: number, P: GodParams, rng: Rng): { x: number; y: number } | null {
    this.weatherPhase += (dt * 2 * Math.PI) / 700;
    this.forces(dt, P, rng);
    this.project(10);
    this.advect(dt);
    this.diffuse(dt);
    this.radiation(dt);
    this.evaporate(dt, P);
    this.microphysics(dt, P);
    return this.lightning(dt, P, rng);
  }

  // -------------------------------------------------------------------------

  private forces(dt: number, P: GodParams, rng: Rng) {
    const { u, v, temp, air } = this;
    // buoyancy relative to the mean temperature of the same altitude band
    for (let j = 0; j < AIR_NY; j++) {
      let s = 0;
      let c = 0;
      for (let i = 0; i < AIR_NX; i++) {
        const idx = j * AIR_NX + i;
        if (air[idx]) {
          s += temp[idx];
          c++;
        }
      }
      if (!c) continue;
      const mean = s / c;
      for (let i = 0; i < AIR_NX; i++) {
        const idx = j * AIR_NX + i;
        if (air[idx]) v[idx] -= AIR.BUOYANCY * (temp[idx] - mean) * dt;
      }
    }
    // prevailing wind, stronger aloft
    const U = this.prevailing(P) * AIR.PREVAILING;
    for (let j = 0; j < AIR_NY; j++) {
      const aloft = 1 - j / AIR_NY;
      const target = U * (0.35 + 0.65 * aloft);
      for (let i = 0; i < AIR_NX; i++) {
        const idx = j * AIR_NX + i;
        if (air[idx]) u[idx] += (target - u[idx]) * 0.12 * dt;
      }
    }
    // storm systems: a warm, very humid disturbance drifts in now and then
    this.stormTimer -= dt * (0.25 + P.storms * P.humidity);
    if (this.stormTimer <= 0) {
      this.stormTimer = rng.range(80, 220);
      if (P.storms > 0.05) this.disturb(rng.range(100, WORLD_W - 100), 1.0 * P.storms, 4 * P.humidity);
    }
    const damp = 1 - AIR.DAMPING * dt;
    for (let idx = 0; idx < N; idx++) {
      if (!air[idx]) continue;
      u[idx] *= damp;
      v[idx] *= damp;
      if (u[idx] > 40) u[idx] = 40;
      else if (u[idx] < -40) u[idx] = -40;
      if (v[idx] > 30) v[idx] = 30;
      else if (v[idx] < -30) v[idx] = -30;
    }
    // friction near the ground
    for (let i = 0; i < AIR_NX; i++) {
      const c = this.groundCell(i);
      if (c >= 0) u[c] *= 1 - 0.3 * dt;
    }
  }

  /** Warm, moist, rising air around x (a storm cell). */
  disturb(x: number, heat: number, moisture: number) {
    const i0 = this.column(x - 100);
    const i1 = this.column(x + 100);
    for (let i = i0; i <= i1; i++) {
      const g = this.groundRow[i];
      for (let j = Math.max(0, g - 3); j <= g; j++) {
        const idx = j * AIR_NX + i;
        if (!this.air[idx]) continue;
        this.temp[idx] += heat * 4;
        this.hum[idx] += moisture;
        this.v[idx] -= 6 * heat;
      }
    }
  }

  private project(iters: number) {
    const { u, v, p, div, nbR, nbL, nbD, nbU, nbInv, list, nAir } = this;
    u[DUMMY] = 0;
    v[DUMMY] = 0;
    p[DUMMY] = 0;
    for (let k = 0; k < nAir; k++) {
      const idx = list[k];
      div[idx] = 0.5 * (u[nbR[idx]] - u[nbL[idx]] + v[nbD[idx]] - v[nbU[idx]]);
    }
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < nAir; k++) {
        const idx = list[k];
        const gs = (p[nbR[idx]] + p[nbL[idx]] + p[nbD[idx]] + p[nbU[idx]] - div[idx]) * nbInv[idx];
        p[idx] += 1.7 * (gs - p[idx]);
      }
    }
    for (let k = 0; k < nAir; k++) {
      const idx = list[k];
      const pc = p[idx];
      const pR = nbR[idx] === DUMMY ? pc : p[nbR[idx]];
      const pL = nbL[idx] === DUMMY ? pc : p[nbL[idx]];
      const pD = nbD[idx] === DUMMY ? pc : p[nbD[idx]];
      const pU = nbU[idx] === DUMMY ? pc : p[nbU[idx]];
      u[idx] -= 0.5 * (pR - pL);
      v[idx] -= 0.5 * (pD - pU);
    }
  }

  private advect(dt: number) {
    const { u, v, temp, hum, cloud, air, bu, bv, bt, bh, bc } = this;
    const k = dt / AIR_CELL;
    for (let j = 0; j < AIR_NY; j++) {
      for (let i = 0; i < AIR_NX; i++) {
        const idx = j * AIR_NX + i;
        if (!air[idx]) {
          bu[idx] = 0;
          bv[idx] = 0;
          bt[idx] = temp[idx];
          bh[idx] = hum[idx];
          bc[idx] = 0;
          continue;
        }
        let x = i - u[idx] * k;
        let y = j - v[idx] * k;
        x = Math.max(0, Math.min(AIR_NX - 1, x));
        y = Math.max(0, Math.min(AIR_NY - 1, y));
        let i0 = x | 0;
        let j0 = y | 0;
        if (i0 > AIR_NX - 2) i0 = AIR_NX - 2;
        if (j0 > AIR_NY - 2) j0 = AIR_NY - 2;
        const s = x - i0;
        const t = y - j0;
        const a = j0 * AIR_NX + i0;
        const b = a + 1;
        const c = a + AIR_NX;
        const d = c + 1;
        const w00 = air[a] ? (1 - s) * (1 - t) : 0;
        const w10 = air[b] ? s * (1 - t) : 0;
        const w01 = air[c] ? (1 - s) * t : 0;
        const w11 = air[d] ? s * t : 0;
        const ws = w00 + w10 + w01 + w11;
        if (ws < 1e-4) {
          bu[idx] = u[idx];
          bv[idx] = v[idx];
          bt[idx] = temp[idx];
          bh[idx] = hum[idx];
          bc[idx] = cloud[idx];
          continue;
        }
        const inv = 1 / ws;
        bu[idx] = (w00 * u[a] + w10 * u[b] + w01 * u[c] + w11 * u[d]) * inv;
        bv[idx] = (w00 * v[a] + w10 * v[b] + w01 * v[c] + w11 * v[d]) * inv;
        bt[idx] = (w00 * temp[a] + w10 * temp[b] + w01 * temp[c] + w11 * temp[d]) * inv;
        bh[idx] = (w00 * hum[a] + w10 * hum[b] + w01 * hum[c] + w11 * hum[d]) * inv;
        bc[idx] = (w00 * cloud[a] + w10 * cloud[b] + w01 * cloud[c] + w11 * cloud[d]) * inv;
      }
    }
    // copy back (rather than swap), so the arrays stay put for other threads that read them
    u.set(bu);
    v.set(bv);
    temp.set(bt);
    hum.set(bh);
    cloud.set(bc);
  }

  /** A little sideways mixing of heat and vapour between neighbouring air cells. */
  private diffuse(dt: number) {
    const { temp, hum, list, nAir, nbR } = this;
    const k = Math.min(0.2, 0.6 * dt);
    for (let q = 0; q < nAir; q++) {
      const idx = list[q];
      const r = nbR[idx];
      if (r !== DUMMY) {
        const dT = (temp[r] - temp[idx]) * k * 0.5;
        temp[idx] += dT;
        temp[r] -= dT;
        const dH = (hum[r] - hum[idx]) * k * 0.5;
        hum[idx] += dH;
        hum[r] -= dH;
      }
    }
  }

  /** Heating from the ground below; the free air relaxes to the climate's lapse-rate profile. */
  private radiation(dt: number) {
    const { temp, air, surfaceT, surfaceY } = this;
    const climate = this.climateT;
    for (let i = 0; i < AIR_NX; i++) {
      const g = this.groundRow[i];
      for (let j = 0; j <= g; j++) {
        const idx = j * AIR_NX + i;
        if (!air[idx]) continue;
        const alt = Math.max(0, -airRowY(j));
        const eq = j === g ? surfaceT[i] - AIR.LAPSE * Math.max(0, surfaceY[i] - airRowY(j)) : climate - AIR.LAPSE * alt;
        const rate = j === g ? AIR.SURFACE_RELAX : AIR.RAD_RELAX;
        temp[idx] += (eq - temp[idx]) * Math.min(1, rate * dt);
        // large-scale sinking air dries the free atmosphere (clouds need updrafts to form)
        if (j < g) {
          const bg = AIR.RH_ALOFT * qsat(temp[idx]);
          if (this.hum[idx] > bg) this.hum[idx] += (bg - this.hum[idx]) * Math.min(1, AIR.SUBSIDENCE * dt);
        }
      }
    }
  }

  /** Evaporation from the sea surface (land evaporation is handled by the soil). */
  private evaporate(dt: number, P: GodParams) {
    const { hum, u, surfaceT } = this;
    for (let i = 0; i < AIR_NX; i++) {
      this.evap[i] = 0;
      if (!this.overSea[i]) continue;
      const c = this.groundCell(i);
      if (c < 0) continue;
      const deficit = qsat(surfaceT[i]) * 0.92 - hum[c];
      if (deficit <= 0) continue;
      const e = AIR.EVAP_SEA * P.humidity * deficit * (0.4 + Math.abs(u[c]) / 8) * dt;
      hum[c] += e;
      this.evap[i] = e;
    }
  }

  /** Condensation, cloud evaporation, rain. */
  private microphysics(dt: number, P: GodParams) {
    const { temp, hum, cloud, air } = this;
    const latent = AIR.LATENT * (0.6 + 0.4 * P.storms);
    for (let i = 0; i < AIR_NX; i++) {
      let fall = 0;
      let column = 0;
      for (let j = 0; j < AIR_NY; j++) {
        const idx = j * AIR_NX + i;
        if (!air[idx]) continue;
        const qs = qsat(temp[idx]);
        if (hum[idx] > qs) {
          const c = (hum[idx] - qs) * Math.min(1, AIR.CONDENSE * dt);
          hum[idx] -= c;
          cloud[idx] += c;
          temp[idx] += latent * c;
        } else if (cloud[idx] > 0) {
          const e = Math.min(cloud[idx], (qs - hum[idx]) * 0.3 * dt);
          cloud[idx] -= e;
          hum[idx] += e;
          temp[idx] -= latent * e;
        }
        // droplets grow into rain
        if (cloud[idx] > AIR.RAIN_CRIT) {
          const r = (cloud[idx] - AIR.RAIN_CRIT) * AIR.RAIN_RATE * dt;
          cloud[idx] -= r;
          fall += r;
        }
        // falling rain partly evaporates in dry air below the cloud (virga)
        if (fall > 0 && hum[idx] < qs) {
          const ev = fall * 0.12 * (1 - hum[idx] / qs);
          fall -= ev;
          hum[idx] += ev;
          temp[idx] -= latent * ev * 0.5;
        }
        column += cloud[idx];
      }
      this.rainStep[i] = fall;
      this.rain[i] += (fall / Math.max(dt, 1e-3) - this.rain[i]) * Math.min(1, dt * 1.5);
      this.shade[i] = 1 - Math.exp(-column * 0.25);
    }
  }

  private lightning(dt: number, P: GodParams, rng: Rng): { x: number; y: number } | null {
    if (this.bolt) {
      this.bolt.age += dt;
      if (this.bolt.age > 0.5) this.bolt = null;
    }
    if (this.bolt || P.storms <= 0) return null;
    for (let q = 0; q < this.nAir; q++) {
      const idx = this.list[q];
      const c = this.cloud[idx];
      if (c < 1.0) continue;
      const up = Math.max(0, -this.v[idx]);
      const p = AIR.LIGHTNING * P.storms * (c - 1.0) * (0.3 + up / 4) * dt;
      if (rng.next() < p) {
        const i = idx % AIR_NX;
        const j = (idx / AIR_NX) | 0;
        return this.strike(airColX(i) + rng.range(-15, 15), airRowY(j), rng);
      }
    }
    return null;
  }

  /** Create a lightning bolt from (x, y) down to the surface. */
  strike(x: number, y: number, rng: Rng): { x: number; y: number } {
    const i = this.column(x);
    const gy = this.surfaceY[i];
    // a jagged bolt: random kinks that wander but come back towards the strike point
    const pts: number[] = [];
    const steps = 9;
    let px = x;
    const target = x + rng.range(-40, 40);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      pts.push(px, y + (gy - y) * t + (s > 0 && s < steps ? rng.range(-8, 8) : 0));
      px += (target - px) * 0.25 + rng.range(-22, 22);
    }
    const hx = pts[pts.length - 2];
    this.bolt = { pts, age: 0, x: hx, y: gy };
    return { x: hx, y: gy };
  }

  /** Mean values over the air (for stats and the top bar). */
  summary() {
    let h = 0;
    let c = 0;
    let n = 0;
    for (let q = 0; q < this.nAir; q++) {
      const idx = this.list[q];
      h += this.hum[idx];
      c += this.cloud[idx];
      n++;
    }
    let rain = 0;
    let shade = 0;
    for (let i = 0; i < AIR_NX; i++) {
      rain += this.rain[i];
      shade += this.shade[i];
    }
    return { humidity: h / Math.max(1, n), cloud: c / Math.max(1, n), rain: rain / AIR_NX, cover: shade / AIR_NX };
  }
}
