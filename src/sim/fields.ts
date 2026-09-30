import { NX, NY, BIO, CELL, CHEM, GRID_TOP, WORLD_H, GodParams } from './params';
import { Terrain, richness } from './terrain';
import { Rng } from './rng';

// Grid size, bound when a Fields is created (the world width is chosen per world).
let N = 0;
/** Arrays carry one extra slot (index N) that is always 0; missing neighbours point at it. */
let NA = 0;
let DUMMY = 0;
function bindGrid(): number {
  N = NX * NY;
  NA = N + 1;
  DUMMY = N;
  return N;
}

/** World y of the centre of grid row j. */
export const rowY = (j: number) => GRID_TOP + (j + 0.5) * CELL;

/**
 * The sea: an incompressible fluid (stable-fluids solver) that carries heat and dissolved
 * chemistry (O₂, CO₂, nutrients, sulfide). Everything is stored per grid cell as an amount.
 * Cells above the (tidal) sea level or inside the ground are masked out.
 */
export class Fields {
  /** Number of grid cells (binds the module's grid size first, so it must stay the first field). */
  readonly size = bindGrid();
  u = new Float32Array(NA);
  v = new Float32Array(NA);
  temp = new Float32Array(NA);
  o2 = new Float32Array(NA);
  co2 = new Float32Array(NA);
  nut = new Float32Array(NA);
  sulf = new Float32Array(NA);
  /** Pheromones (chemical signals released by organisms): two channels whose meaning evolves. */
  sigA = new Float32Array(NA);
  sigB = new Float32Array(NA);
  light = new Float32Array(N);
  /** Chlorophyll-mass accumulated by organisms since the last light update. */
  shade = new Float32Array(N);
  shadeTicks = 0;

  /** 1 where there is no water: ground, rock, or air above the sea surface. */
  solid = new Uint8Array(N);
  /** 1 where there is ground or rock. */
  ground = new Uint8Array(N);
  rockAt = new Int16Array(N);
  floorCell = new Uint8Array(N);
  /** First water row in each column, or -1 where the column is dry land. */
  surfRow = new Int16Array(NX);
  fluidCount = 0;
  seaLevel = 0;

  atmO2 = 0.6;
  atmCO2 = 1.0;
  meanTemp = 12;
  airTemp = 18;
  /** Wind stress on the sea surface per column, set from the atmosphere each step. */
  windX = new Float32Array(NX);
  /** Air temperature just above the sea surface per column. */
  airT = new Float32Array(NX).fill(18);
  /** Fraction of sunlight getting through the clouds per column. */
  sunCol = new Float32Array(NX).fill(1);

  // sample output (avoids allocating)
  su = 0;
  sv = 0;

  /** Turbulent eddies: unresolved turbulence stirred up by wind and convection. */
  eddies: { x: number; y: number; r: number; s: number; life: number; age: number }[] = [];

  private bu = new Float32Array(NA);
  private bv = new Float32Array(NA);
  private bt = new Float32Array(NA);
  private bo = new Float32Array(NA);
  private bc = new Float32Array(NA);
  private bn = new Float32Array(NA);
  private bs = new Float32Array(NA);
  private bA = new Float32Array(NA);
  private bB = new Float32Array(NA);
  private p = new Float32Array(NA);
  private div = new Float32Array(N);
  private curl = new Float32Array(N);
  // neighbour tables (rebuilt with the mask)
  private nbR = new Int32Array(N);
  private nbL = new Int32Array(N);
  private nbD = new Int32Array(N);
  private nbU = new Int32Array(N);
  private nbInv = new Float32Array(N);
  private nbCnt = new Float32Array(N);
  private fluidList = new Int32Array(N);
  private nFluid = 0;
  private tmp = new Float32Array(NA);

  init(t: Terrain, seaLevel: number) {
    this.seaLevel = seaLevel;
    this.rebuildSolid(t);
    for (let j = 0; j < NY; j++) {
      const d = Math.max(0, rowY(j)) / WORLD_H;
      for (let i = 0; i < NX; i++) {
        const idx = j * NX + i;
        this.temp[idx] = 22 - 16 * d;
        this.o2[idx] = this.atmO2 * CHEM.O2_EQ * (1 - 0.3 * d);
        this.co2[idx] = this.atmCO2 * CHEM.CO2_EQ;
        this.nut[idx] = 0.1 + 0.12 * d;
        this.sulf[idx] = 0;
      }
    }
  }

  /** Recompute ground/rock cells, then the water mask. */
  rebuildSolid(t: Terrain) {
    const { ground, rockAt } = this;
    for (let j = 0; j < NY; j++) {
      const yc = rowY(j);
      for (let i = 0; i < NX; i++) {
        const xc = (i + 0.5) * CELL;
        const idx = j * NX + i;
        let s = yc > t.floorY(xc) ? 1 : 0;
        rockAt[idx] = -1;
        for (let k = 0; k < t.rocks.length; k++) {
          const r = t.rocks[k];
          const dx = xc - r.x;
          const dy = yc - r.y;
          if (dx * dx + dy * dy < r.r * r.r * 0.8) {
            s = 1;
            rockAt[idx] = k;
            break;
          }
        }
        ground[idx] = s;
      }
    }
    for (const r of t.rocks) r.solidR = r.r;
    this.applyMask(false);
  }

  /** Move the sea surface (tides). Water drains from or floods into the surface rows. */
  setSeaLevel(level: number) {
    if (Math.abs(level - this.seaLevel) < 1e-3) return;
    this.seaLevel = level;
    this.applyMask(true);
  }

  private applyMask(conserve: boolean) {
    const { solid, ground, temp, o2, co2, nut, sulf, sigA, sigB, u, v } = this;
    const sl = this.seaLevel;
    let changed = false;
    // bottom-up, so a flooding cell can take water from an already-wet cell below
    for (let j = NY - 1; j >= 0; j--) {
      const air = rowY(j) < sl;
      for (let i = 0; i < NX; i++) {
        const idx = j * NX + i;
        const s = ground[idx] || air ? 1 : 0;
        if (s === solid[idx]) continue;
        changed = true;
        const below = j < NY - 1 && !solid[idx + NX] ? idx + NX : -1;
        if (s) {
          // drained: its dissolved matter settles into the water below
          if (conserve && below >= 0 && !ground[idx]) {
            o2[below] += o2[idx];
            co2[below] += co2[idx];
            nut[below] += nut[idx];
            sulf[below] += sulf[idx];
          }
          u[idx] = 0;
          v[idx] = 0;
          sigA[idx] = 0;
          sigB[idx] = 0;
        } else if (conserve && below >= 0) {
          // flooded: shares the water of the cell below it
          temp[idx] = temp[below];
          o2[idx] = o2[below] *= 0.5;
          co2[idx] = co2[below] *= 0.5;
          nut[idx] = nut[below] *= 0.5;
          sulf[idx] = sulf[below] *= 0.5;
          sigA[idx] = sigA[below];
          sigB[idx] = sigB[below];
        }
        solid[idx] = s;
      }
    }
    if (!changed && conserve) return;
    let fluid = 0;
    for (let i = 0; i < NX; i++) this.surfRow[i] = -1;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const idx = j * NX + i;
        if (solid[idx]) continue;
        fluid++;
        if (this.surfRow[i] < 0) this.surfRow[i] = j;
      }
    }
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const idx = j * NX + i;
        this.floorCell[idx] = !solid[idx] && (j === NY - 1 || ground[idx + NX]) ? 1 : 0;
      }
    }
    this.fluidCount = fluid;
    this.buildNeighbours();
  }

  private buildNeighbours() {
    const { solid, nbR, nbL, nbD, nbU, nbInv, nbCnt, fluidList } = this;
    let k = 0;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const idx = j * NX + i;
        const r = i < NX - 1 && !solid[idx + 1] ? idx + 1 : DUMMY;
        const l = i > 0 && !solid[idx - 1] ? idx - 1 : DUMMY;
        const d = j < NY - 1 && !solid[idx + NX] ? idx + NX : DUMMY;
        const u = j > 0 && !solid[idx - NX] ? idx - NX : DUMMY;
        nbR[idx] = r;
        nbL[idx] = l;
        nbD[idx] = d;
        nbU[idx] = u;
        const cnt = (r !== DUMMY ? 1 : 0) + (l !== DUMMY ? 1 : 0) + (d !== DUMMY ? 1 : 0) + (u !== DUMMY ? 1 : 0);
        nbInv[idx] = cnt ? 1 / cnt : 0;
        nbCnt[idx] = cnt;
        if (!solid[idx]) fluidList[k++] = idx;
      }
    }
    this.nFluid = k;
  }

  cellIndex(x: number, y: number): number {
    let i = (x / CELL) | 0;
    let j = ((y - GRID_TOP) / CELL) | 0;
    if (i < 0) i = 0;
    else if (i >= NX) i = NX - 1;
    if (j < 0) j = 0;
    else if (j >= NY) j = NY - 1;
    return j * NX + i;
  }

  /** Grid column of a world x. */
  column(x: number): number {
    const i = (x / CELL) | 0;
    return i < 0 ? 0 : i >= NX ? NX - 1 : i;
  }

  /** Bilinear flow velocity at a world position → (su, sv). */
  sampleVel(x: number, y: number) {
    let gx = x / CELL - 0.5;
    let gy = (y - GRID_TOP) / CELL - 0.5;
    if (gx < 0) gx = 0;
    else if (gx > NX - 1.001) gx = NX - 1.001;
    if (gy < 0) gy = 0;
    else if (gy > NY - 1.001) gy = NY - 1.001;
    const i = gx | 0;
    const j = gy | 0;
    const s = gx - i;
    const t = gy - j;
    const a = j * NX + i;
    const u = this.u;
    const v = this.v;
    this.su = (u[a] * (1 - s) + u[a + 1] * s) * (1 - t) + (u[a + NX] * (1 - s) + u[a + NX + 1] * s) * t;
    this.sv = (v[a] * (1 - s) + v[a + 1] * s) * (1 - t) + (v[a + NX] * (1 - s) + v[a + NX + 1] * s) * t;
  }

  /** Add to the surface water of a column (rain, rivers). */
  addSurface(i: number, dTemp: number, dNut: number) {
    const j = this.surfRow[i];
    if (j < 0) return false;
    const idx = j * NX + i;
    this.temp[idx] += dTemp;
    this.nut[idx] += dNut;
    return true;
  }

  step(dtf: number, P: GodParams, t: Terrain, sunNow: number, rng: Rng) {
    this.applyForces(dtf, P, t, rng);
    // a little viscosity damps the grid-scale (checkerboard) modes of the collocated solver
    this.diffuse(this.u, CHEM.VISCOSITY);
    this.diffuse(this.v, CHEM.VISCOSITY);
    this.project(8);
    this.advect(dtf);
    this.diffuse(this.temp, CHEM.DIFF_T);
    this.diffuse(this.o2, CHEM.DIFF_GAS);
    this.diffuse(this.co2, CHEM.DIFF_GAS);
    this.diffuse(this.nut, CHEM.DIFF_NUT);
    this.diffuse(this.sulf, CHEM.DIFF_SULF);
    this.diffuse(this.sigA, BIO.DIFF_SIG);
    this.diffuse(this.sigB, BIO.DIFF_SIG);
    this.sources(dtf, P, t, sunNow, rng);
    this.computeLight(sunNow);
  }

  // -------------------------------------------------------------------------

  private applyForces(dtf: number, P: GodParams, t: Terrain, rng: Rng) {
    const { u, v, temp, solid, curl, surfRow, windX } = this;
    let s = 0;
    let c = 0;
    for (let idx = 0; idx < N; idx++) {
      if (solid[idx]) continue;
      s += temp[idx];
      c++;
    }
    this.meanTemp = c ? s / c : 10;

    // thermal buoyancy: warm water rises (−y)
    const b = CHEM.BUOYANCY * dtf;
    const mt = this.meanTemp;
    for (let idx = 0; idx < N; idx++) {
      if (solid[idx]) continue;
      v[idx] -= b * (temp[idx] - mt);
    }

    // wind drags the surface layer
    let windy = 0;
    for (let i = 0; i < NX; i++) {
      const j = surfRow[i];
      if (j < 0) continue;
      const w = windX[i] * CHEM.WIND_FORCE * dtf;
      windy += Math.abs(windX[i]);
      const idx = j * NX + i;
      u[idx] += w;
      if (j + 1 < NY && !solid[idx + NX]) u[idx + NX] += w * 0.45;
    }
    windy /= NX;

    // vent jets
    for (const vent of t.vents) {
      let idx = this.cellIndex(vent.x, vent.y - CELL * 0.6);
      while (idx >= NX && solid[idx]) idx -= NX;
      for (let k = 0; k < 3 && idx >= 0; k++, idx -= NX) {
        if (!solid[idx]) v[idx] -= CHEM.VENT_JET * vent.power * P.vents * dtf * (1 - k * 0.3);
      }
    }

    // turbulent eddies (mostly in the wind-mixed upper layer; storms stir harder)
    const spawnRate = CHEM.EDDY_RATE * (0.35 + windy);
    if (this.eddies.length < 8 && rng.next() < spawnRate * dtf) {
      const depth = Math.pow(rng.next(), 1.6);
      const x = rng.range(60, NX * CELL - 60);
      const y = this.seaLevel + 40 + depth * (WORLD_H - 200);
      if (y < t.floorY(x) - 30) {
        this.eddies.push({
          x,
          y,
          r: rng.range(45, 130),
          s: (rng.next() < 0.5 ? -1 : 1) * CHEM.EDDY_STRENGTH * (0.5 + windy) * (1 - depth * 0.6),
          life: rng.range(5, 14),
          age: 0,
        });
      }
    }
    for (const e of this.eddies) {
      e.age += dtf;
      const env = Math.sin(Math.PI * Math.min(1, e.age / e.life));
      const i0 = Math.max(1, Math.floor((e.x - e.r) / CELL));
      const i1 = Math.min(NX - 2, Math.floor((e.x + e.r) / CELL));
      const j0 = Math.max(1, Math.floor((e.y - e.r - GRID_TOP) / CELL));
      const j1 = Math.min(NY - 2, Math.floor((e.y + e.r - GRID_TOP) / CELL));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const idx = j * NX + i;
          if (solid[idx]) continue;
          const dx = (i + 0.5) * CELL - e.x;
          const dy = rowY(j) - e.y;
          const q = Math.sqrt(dx * dx + dy * dy) / e.r;
          if (q >= 1) continue;
          const f = (e.s * env * dtf * Math.exp(-q * q * 3)) / e.r;
          u[idx] -= dy * f;
          v[idx] += dx * f;
        }
      }
    }
    this.eddies = this.eddies.filter((e) => e.age < e.life);

    // vorticity confinement: keeps small eddies alive
    for (let j = 1; j < NY - 1; j++) {
      for (let i = 1; i < NX - 1; i++) {
        const idx = j * NX + i;
        curl[idx] = 0.5 * (v[idx + 1] - v[idx - 1] - (u[idx + NX] - u[idx - NX]));
      }
    }
    const eps = CHEM.VORTICITY * dtf;
    for (let j = 2; j < NY - 2; j++) {
      for (let i = 2; i < NX - 2; i++) {
        const idx = j * NX + i;
        if (solid[idx]) continue;
        const gx = 0.5 * (Math.abs(curl[idx + 1]) - Math.abs(curl[idx - 1]));
        const gy = 0.5 * (Math.abs(curl[idx + NX]) - Math.abs(curl[idx - NX]));
        const len = Math.sqrt(gx * gx + gy * gy) + 1e-5;
        const w = curl[idx];
        u[idx] += (eps * gy * w) / len;
        v[idx] -= (eps * gx * w) / len;
      }
    }

    // damping and speed limit
    const damp = 1 - CHEM.DAMPING * dtf;
    const max2 = CHEM.MAX_FLOW * CHEM.MAX_FLOW;
    for (let idx = 0; idx < N; idx++) {
      if (solid[idx]) {
        u[idx] = 0;
        v[idx] = 0;
        continue;
      }
      let uu = u[idx] * damp;
      let vv = v[idx] * damp;
      const s2 = uu * uu + vv * vv;
      if (s2 > max2) {
        const k = CHEM.MAX_FLOW / Math.sqrt(s2);
        uu *= k;
        vv *= k;
      }
      u[idx] = uu;
      v[idx] = vv;
    }
  }

  /** Make the flow divergence-free (SOR pressure solve; solid walls are no-flux). */
  private project(iters: number) {
    const { u, v, p, div, nbR, nbL, nbD, nbU, nbInv, fluidList, nFluid } = this;
    u[DUMMY] = 0;
    v[DUMMY] = 0;
    p[DUMMY] = 0;
    for (let k = 0; k < nFluid; k++) {
      const idx = fluidList[k];
      div[idx] = 0.5 * (u[nbR[idx]] - u[nbL[idx]] + v[nbD[idx]] - v[nbU[idx]]);
    }
    const w = 1.7; // over-relaxation
    for (let it = 0; it < iters; it++) {
      for (let k = 0; k < nFluid; k++) {
        const idx = fluidList[k];
        const gs = (p[nbR[idx]] + p[nbL[idx]] + p[nbD[idx]] + p[nbU[idx]] - div[idx]) * nbInv[idx];
        p[idx] += w * (gs - p[idx]);
      }
    }
    for (let k = 0; k < nFluid; k++) {
      const idx = fluidList[k];
      const pc = p[idx];
      const r = nbR[idx];
      const l = nbL[idx];
      const d = nbD[idx];
      const up = nbU[idx];
      const pR = r === DUMMY ? pc : p[r];
      const pL = l === DUMMY ? pc : p[l];
      const pD = d === DUMMY ? pc : p[d];
      const pU = up === DUMMY ? pc : p[up];
      u[idx] -= 0.5 * (pR - pL);
      v[idx] -= 0.5 * (pD - pU);
    }
  }

  /** Semi-Lagrangian advection of velocity and all scalars, with a global mass correction. */
  private advect(dtf: number) {
    const { u, v, temp, o2, co2, nut, sulf, sigA, sigB, solid, bu, bv, bt, bo, bc, bn, bs, bA, bB } = this;
    const k = dtf / CELL;
    let o2a = 0;
    let o2b = 0;
    let co2a = 0;
    let co2b = 0;
    let nuta = 0;
    let nutb = 0;
    let sa = 0;
    let sb = 0;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const idx = j * NX + i;
        if (solid[idx]) {
          bu[idx] = 0;
          bv[idx] = 0;
          bt[idx] = temp[idx];
          bo[idx] = o2[idx];
          bc[idx] = co2[idx];
          bn[idx] = nut[idx];
          bs[idx] = sulf[idx];
          bA[idx] = sigA[idx];
          bB[idx] = sigB[idx];
          continue;
        }
        let x = i - u[idx] * k;
        let y = j - v[idx] * k;
        if (x < 0) x = 0;
        else if (x > NX - 1) x = NX - 1;
        if (y < 0) y = 0;
        else if (y > NY - 1) y = NY - 1;
        let i0 = x | 0;
        let j0 = y | 0;
        if (i0 > NX - 2) i0 = NX - 2;
        if (j0 > NY - 2) j0 = NY - 2;
        const s = x - i0;
        const t = y - j0;
        const a = j0 * NX + i0;
        const b = a + 1;
        const c = a + NX;
        const d = c + 1;
        const w00 = (1 - s) * (1 - t);
        const w10 = s * (1 - t);
        const w01 = (1 - s) * t;
        const w11 = s * t;
        bu[idx] = w00 * u[a] + w10 * u[b] + w01 * u[c] + w11 * u[d];
        bv[idx] = w00 * v[a] + w10 * v[b] + w01 * v[c] + w11 * v[d];
        const m00 = solid[a] ? 0 : w00;
        const m10 = solid[b] ? 0 : w10;
        const m01 = solid[c] ? 0 : w01;
        const m11 = solid[d] ? 0 : w11;
        const ms = m00 + m10 + m01 + m11;
        o2a += o2[idx];
        co2a += co2[idx];
        nuta += nut[idx];
        sa += sulf[idx];
        if (ms < 1e-4) {
          bt[idx] = temp[idx];
          bo[idx] = o2[idx];
          bc[idx] = co2[idx];
          bn[idx] = nut[idx];
          bs[idx] = sulf[idx];
          bA[idx] = sigA[idx];
          bB[idx] = sigB[idx];
        } else {
          const inv = 1 / ms;
          bt[idx] = (m00 * temp[a] + m10 * temp[b] + m01 * temp[c] + m11 * temp[d]) * inv;
          bo[idx] = (m00 * o2[a] + m10 * o2[b] + m01 * o2[c] + m11 * o2[d]) * inv;
          bc[idx] = (m00 * co2[a] + m10 * co2[b] + m01 * co2[c] + m11 * co2[d]) * inv;
          bn[idx] = (m00 * nut[a] + m10 * nut[b] + m01 * nut[c] + m11 * nut[d]) * inv;
          bs[idx] = (m00 * sulf[a] + m10 * sulf[b] + m01 * sulf[c] + m11 * sulf[d]) * inv;
          bA[idx] = (m00 * sigA[a] + m10 * sigA[b] + m01 * sigA[c] + m11 * sigA[d]) * inv;
          bB[idx] = (m00 * sigB[a] + m10 * sigB[b] + m01 * sigB[c] + m11 * sigB[d]) * inv;
        }
        o2b += bo[idx];
        co2b += bc[idx];
        nutb += bn[idx];
        sb += bs[idx];
      }
    }
    // swap buffers
    this.u = bu;
    this.bu = u;
    this.v = bv;
    this.bv = v;
    this.temp = bt;
    this.bt = temp;
    this.o2 = bo;
    this.bo = o2;
    this.co2 = bc;
    this.bc = co2;
    this.nut = bn;
    this.bn = nut;
    this.sulf = bs;
    this.bs = sulf;
    this.sigA = bA;
    this.bA = sigA;
    this.sigB = bB;
    this.bB = sigB;
    // conserve totals of dissolved matter
    this.rescale(this.o2, o2a, o2b);
    this.rescale(this.co2, co2a, co2b);
    this.rescale(this.nut, nuta, nutb);
    this.rescale(this.sulf, sa, sb);
  }

  private rescale(f: Float32Array, before: number, after: number) {
    if (after <= 1e-9) return;
    const k = before / after;
    if (Math.abs(k - 1) < 1e-7) return;
    const solid = this.solid;
    for (let idx = 0; idx < N; idx++) if (!solid[idx]) f[idx] *= k;
  }

  /** Explicit, conservative diffusion with no flux into solids. */
  private diffuse(f: Float32Array, k: number) {
    const { tmp, nbR, nbL, nbD, nbU, nbCnt, fluidList, nFluid } = this;
    f[DUMMY] = 0;
    tmp.set(f);
    for (let q = 0; q < nFluid; q++) {
      const idx = fluidList[q];
      const c = f[idx];
      tmp[idx] = c + k * (f[nbR[idx]] + f[nbL[idx]] + f[nbD[idx]] + f[nbU[idx]] - nbCnt[idx] * c);
    }
    f.set(tmp);
  }

  private sources(dtf: number, P: GodParams, t: Terrain, sunNow: number, rng: Rng) {
    const { temp, o2, co2, nut, sulf, solid, floorCell, u, v, surfRow, airT } = this;

    // surface: gas exchange with the atmosphere, heat exchange with the air, solar heating
    this.airTemp = 13 + 9 * sunNow + P.tempOffset;
    const ge = Math.min(1, CHEM.GAS_EXCHANGE * dtf);
    const he = Math.min(1, CHEM.HEAT_EXCHANGE * dtf);
    const eqO = this.atmO2 * CHEM.O2_EQ;
    const eqC = this.atmCO2 * CHEM.CO2_EQ;
    let dO = 0;
    let dC = 0;
    for (let i = 0; i < NX; i++) {
      const j = surfRow[i];
      if (j < 0) continue;
      const idx = j * NX + i;
      const fo = (eqO - o2[idx]) * ge;
      o2[idx] += fo;
      dO += fo;
      const fc = (eqC - co2[idx]) * ge;
      co2[idx] += fc;
      dC += fc;
      temp[idx] += (airT[i] - temp[idx]) * he;
      for (let k = 0; k < 4 && j + k < NY; k++) {
        const q = idx + k * NX;
        if (solid[q]) break;
        temp[q] += sunNow * CHEM.SOLAR_HEAT * Math.exp(-k * 0.7) * dtf;
      }
    }
    this.atmO2 = Math.max(0, this.atmO2 - dO / (CHEM.ATM_CELLS * CHEM.O2_EQ));
    this.atmCO2 = Math.max(0, this.atmCO2 - dC / (CHEM.ATM_CELLS * CHEM.CO2_EQ));

    // the deep sea floor is cold
    const deep = CHEM.DEEP_TEMP + P.tempOffset * 0.5;
    const dc = CHEM.DEEP_COOL * dtf;
    for (let idx = 0; idx < N; idx++) {
      if (!floorCell[idx]) continue;
      // only deep water is chilled by the floor; shallows follow the air
      if (rowY((idx / NX) | 0) > 300) temp[idx] += (deep - temp[idx]) * dc;
    }

    // hydrothermal vents: heat, sulfide, minerals, CO₂
    for (const vent of t.vents) {
      const pw = vent.power * P.vents;
      if (pw <= 0) continue;
      let idx = this.cellIndex(vent.x, vent.y - CELL * 0.6);
      while (idx >= NX && solid[idx]) idx -= NX;
      for (let k = 0; k < 2 && idx >= 0; k++, idx -= NX) {
        if (solid[idx]) continue;
        const share = k === 0 ? 0.65 : 0.35;
        if (k === 0) temp[idx] += (CHEM.VENT_TEMP - temp[idx]) * Math.min(1, CHEM.VENT_HEAT * pw * dtf);
        sulf[idx] += CHEM.VENT_SULFIDE * pw * dtf * share;
        nut[idx] += CHEM.VENT_NUTRIENT * pw * dtf * share;
        co2[idx] += CHEM.VENT_CO2 * pw * dtf * share;
      }
    }

    // rocks weather, leaching minerals into the water
    let rebuild = false;
    for (let k = 0; k < t.rocks.length; k++) {
      const rock = t.rocks[k];
      const a = rng.range(-Math.PI, 0);
      const px = rock.x + Math.cos(a) * (rock.r + CELL * 0.5);
      const py = rock.y + Math.sin(a) * (rock.r + CELL * 0.5);
      const ci = this.cellIndex(px, py);
      if (solid[ci]) continue;
      const acid = 0.5 + (0.5 * co2[ci]) / CHEM.CO2_EQ;
      const flow = 1 + Math.hypot(u[ci], v[ci]) / 15;
      const rate =
        CHEM.EROSION * P.erosion * rock.r * (1 - rock.type.hardness) * richness(rock.type.minerals) * acid * flow;
      const amt = rate * dtf * 4;
      nut[ci] += amt;
      rock.released += amt;
      rock.r = Math.sqrt(Math.max(rock.r0 * rock.r0 * 0.2, rock.r * rock.r - amt * 2));
      if (rock.solidR - rock.r > 1.5) rebuild = true;
    }
    if (rebuild) this.rebuildSolid(t);

    // sulfide oxidises (faster when oxygen is around)
    const sox = CHEM.SULF_OX * dtf;
    for (let idx = 0; idx < N; idx++) {
      const s = sulf[idx];
      if (s < 1e-5) continue;
      const o = o2[idx];
      const ox = Math.min(s, s * sox * (0.25 + o / (o + 3)));
      sulf[idx] = s - ox;
      o2[idx] = Math.max(0, o - ox * 0.5);
    }

    for (let idx = 0; idx < N; idx++) {
      if (o2[idx] < 0) o2[idx] = 0;
      if (co2[idx] < 0) co2[idx] = 0;
      if (nut[idx] < 0) nut[idx] = 0;
    }

    // pheromones break down (the "pheromones" law sets how long they last)
    const keep = P.pheromones > 0.01 ? Math.max(0, 1 - (BIO.SIG_DECAY / P.pheromones) * dtf) : 0;
    const { sigA, sigB } = this;
    for (let idx = 0; idx < N; idx++) {
      sigA[idx] *= keep;
      sigB[idx] *= keep;
    }
  }

  private computeLight(sunNow: number) {
    const { light, shade, solid, ground } = this;
    const inv = 1 / Math.max(1, this.shadeTicks);
    const sl = this.seaLevel;
    for (let i = 0; i < NX; i++) {
      let cum = 0;
      for (let j = 0; j < NY; j++) {
        const idx = j * NX + i;
        if (solid[idx]) {
          light[idx] = 0;
          if (ground[idx]) cum += 2;
          shade[idx] = 0;
          continue;
        }
        const depth = Math.max(0, rowY(j) - sl);
        light[idx] = sunNow * this.sunCol[i] * Math.exp(-depth / CHEM.LIGHT_DEPTH - cum);
        cum += shade[idx] * inv * CHEM.SHADE_K;
        shade[idx] = 0;
      }
    }
    this.shadeTicks = 0;
  }

  /** Total dissolved amounts in the water (for stats). */
  totals() {
    let o = 0;
    let c = 0;
    let n = 0;
    let s = 0;
    let t = 0;
    for (let idx = 0; idx < N; idx++) {
      if (this.solid[idx]) continue;
      o += this.o2[idx];
      c += this.co2[idx];
      n += this.nut[idx];
      s += this.sulf[idx];
      t += this.temp[idx];
    }
    return { o2: o, co2: c, nut: n, sulf: s, meanTemp: t / Math.max(1, this.fluidCount) };
  }
}
