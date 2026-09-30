// Sensing, split from the rest of an organism's update so it can run on several threads at once.
//
// Each tick the simulation thread "publishes" what every organism shows the others (position, size,
// glow, chemical signature…) and what it needs to sense with (heading, sense range, eyes…) into flat
// arrays: the board. Sensing then reads only the board and the environment, and writes each
// organism's senses back into the board, so any thread can sense any slice of the organisms.
import type { Atmosphere } from './atmosphere';
import type { Fields } from './fields';
import { A, IN, NI } from './genome';
import { learnBrain, stepBrain, valuesAt } from './brain';
import { MAXC } from './organism';
import { BIO, CHEM, DT, MAX_ORGS, WORLD_H } from './params';
import type { Particles } from './particles';
import { f32, i32, u8 } from './shared';
import type { Soil } from './soil';
import type { SpatialGrid } from './spatial';
import type { World } from './world';

/** What sensing reads besides the board: the world, or a helper thread's view of it. */
export interface SenseSource {
  fields: Fields;
  soil: Soil;
  atmosphere: Atmosphere;
  particles: Particles;
  orgGrid: SpatialGrid;
  partGrid: SpatialGrid;
  sunNow: number;
}

/** Eyes see within ±72° of the direction they face. */
const EYE_COS = 0.3;

export class LifeBoard {
  readonly cap = MAX_ORGS + 256;
  /** Organisms on the board this tick. */
  n = 0;
  // what others see
  readonly x = f32(this.cap);
  readonly y = f32(this.cap);
  readonly r = f32(this.cap);
  readonly glow = f32(this.cap);
  readonly sig = f32(this.cap * 3);
  readonly threat = f32(this.cap);
  readonly green = f32(this.cap);
  readonly alive = u8(this.cap);
  readonly court = u8(this.cap);
  // what it senses with
  readonly heading = f32(this.cap);
  readonly range = f32(this.cap);
  readonly near = f32(this.cap);
  readonly nEyes = u8(this.cap);
  readonly eyes = f32(this.cap * MAXC);
  readonly wet = u8(this.cap);
  readonly topY = f32(this.cap);
  readonly leaf = f32(this.cap);
  readonly acuity = f32(this.cap);
  readonly tempOpt = f32(this.cap);
  readonly tempTol = f32(this.cap);
  // its brain: the arena slot (-1: the simulation thread runs it), the reward and learning rate
  readonly slot = i32(this.cap);
  readonly reward = f32(this.cap);
  readonly learnRate = f32(this.cap);
  // what it senses: all its brain's inputs (its own state here, the surroundings in senseRange)
  readonly inp = f32(this.cap * NI);
  readonly touch = i32(this.cap);

  /** Copy this tick's organisms onto the board (simulation thread). */
  publish(w: World) {
    const orgs = w.orgs;
    const n = Math.min(orgs.length, this.cap);
    this.n = n;
    const sl = w.fields.seaLevel;
    const T = w.terrain;
    for (let i = 0; i < n; i++) {
      const o = orgs[i];
      // in the sea, or out of it (beach at low tide, or inland)?
      const wet = o.y > sl && T.floorY(o.x) > sl;
      o.onLand = !wet;
      this.x[i] = o.x;
      this.y[i] = o.y;
      this.r[i] = o.radius;
      this.glow[i] = o.glow;
      const g = o.genome;
      this.sig[i * 3] = g.sig[0];
      this.sig[i * 3 + 1] = g.sig[1];
      this.sig[i * 3 + 2] = g.sig[2];
      this.threat[i] = Math.min(1, o.frac[A.mouth] * 2.2);
      this.green[i] = Math.min(1, o.frac[A.chloro] * 2);
      this.alive[i] = o.dead ? 0 : 1;
      this.court[i] = o.courting > 0 ? 1 : 0;
      this.heading[i] = o.heading;
      this.range[i] = o.sense;
      // the core senses all around (chemoreception); eye cells extend sight only in the directions they face
      this.near[i] = o.radius + BIO.SENSE_BASE + 8 + BIO.SENSE_RANGE * o.coreFrac[A.sensor] * o.share[0];
      this.nEyes[i] = o.nEyes;
      for (let e = 0; e < o.nEyes; e++) this.eyes[i * MAXC + e] = o.eyeAngle[e];
      this.wet[i] = wet ? 1 : 0;
      this.topY[i] = o.topY;
      this.leaf[i] = o.frac[A.chloro] * o.mass;
      this.acuity[i] = Math.min(1, 0.25 + 5 * o.frac[A.sensor]);
      this.tempOpt[i] = g.tempOpt;
      this.tempTol[i] = g.tempTol;
      this.slot[i] = o.brain.slot;
      this.reward[i] = o.reward;
      this.learnRate[i] = g.learn > 0 ? g.learn * w.params.learning : 0;
      // the brain's inputs from its own state
      const b = i * NI;
      const inp = this.inp;
      inp[b + IN.Bias] = 1;
      inp[b + IN.Energy] = o.energy / o.ecap;
      inp[b + IN.Health] = o.health;
      inp[b + IN.Size] = o.mass / g.divMass;
      inp[b + IN.Clock] = Math.sin(o.age * g.oscFreq * Math.PI * 2);
      inp[b + IN.UpFwd] = -Math.sin(o.heading);
      inp[b + IN.UpSide] = -Math.cos(o.heading);
      inp[b + IN.Pain] = o.pain;
      inp[b + IN.InWater] = wet ? 1 : 0;
      inp[b + IN.Hydration] = o.hydration;
      inp[b + IN.Ready] = o.courting > 0 ? 1 : 0;
    }
  }
}

/** How closely two signatures on the board match: 1 = same lineage, 0 = strangers. */
function kinship(sig: Float32Array, a: number, b: number): number {
  const s0 = sig[a * 3] - sig[b * 3];
  const s1 = sig[a * 3 + 1] - sig[b * 3 + 1];
  const s2 = sig[a * 3 + 2] - sig[b * 3 + 2];
  return 1 - Math.min(1, Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2) / 0.25);
}

const clamp1 = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);

// scratch for eye directions (one per thread)
const eyeX = new Float32Array(MAXC);
const eyeY = new Float32Array(MAXC);

/**
 * Sense for organisms [from, to): nearest stranger and relative, touch, the smell of detritus,
 * the chemistry around and its gradients. Reads the board and the environment; writes only these
 * organisms' senses, so disjoint ranges can run on different threads at once.
 */
export function senseRange(src: SenseSource, b: LifeBoard, from: number, to: number) {
  const F = src.fields;
  const soil = src.soil;
  const air = src.atmosphere;
  const G = src.orgGrid;
  const P = src.particles;
  const PG = src.partGrid;
  const { x: bx, y: by, r: br, alive, sig, court, glow, threat, green, inp } = b;
  for (let i = from; i < to; i++) {
    if (!alive[i]) continue;
    const ox = bx[i];
    const oy = by[i];
    const orad = br[i];
    const wet = b.wet[i] === 1;
    const ci = F.cellIndex(ox, oy);
    const col = soil.column(ox);
    const ac = air.column(ox);
    let T: number;
    let O2: number;
    let NU: number;
    let S: number;
    let L: number;
    if (wet) {
      T = F.temp[ci];
      O2 = F.o2[ci];
      NU = F.nut[ci];
      S = F.sulf[ci];
      L = F.light[ci];
    } else {
      T = soil.temp[col] * 0.6 + air.surfaceAirT(ox) * 0.4;
      O2 = F.atmO2 * CHEM.O2_EQ;
      NU = soil.nutrient[col] * Math.min(1, soil.moisture[col] * 1.5);
      S = 0;
      L = src.sunNow * (1 - 0.7 * air.shade[ac]) * soil.lightAt(col, b.topY[i], b.leaf[i]);
    }
    const heading = b.heading[i];
    const hx = Math.cos(heading);
    const hy = Math.sin(heading);
    const range = b.range[i];
    const nearRange = b.near[i];
    const nEyes = b.nEyes[i];
    for (let e = 0; e < nEyes; e++) {
      eyeX[e] = Math.cos(heading + b.eyes[i * MAXC + e]);
      eyeY[e] = Math.sin(heading + b.eyes[i * MAXC + e]);
    }

    // ---- neighbouring organisms: nearest stranger (prey / threat) and nearest relative ----
    let best = -1;
    let bestGap = 1e9;
    let bestKin = 0;
    let bdx = 0;
    let bdy = 0;
    let bd = 1;
    let kin = -1;
    let kinGap = 1e9;
    let kdx = 0;
    let kdy = 0;
    let kd = 1;
    let touching = 0;
    {
      const cx0 = G.cellX(ox - range);
      const cx1 = G.cellX(ox + range);
      const cy0 = G.cellY(oy - range);
      const cy1 = G.cellY(oy + range);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * G.cols + cx;
          for (let k = G.start[c]; k < G.start[c + 1]; k++) {
            const j = G.items[k];
            if (j === i || !alive[j]) continue;
            const dx = bx[j] - ox;
            const dy = by[j] - oy;
            const d2 = dx * dx + dy * dy;
            const reach = range + br[j];
            if (d2 > reach * reach) continue;
            const d = Math.sqrt(d2) + 1e-6;
            const gap = d - orad - br[j];
            if (gap < 0.8) touching++;
            // can it be seen?
            if (nEyes > 0 && d - br[j] > nearRange) {
              let seen = false;
              const ux = dx / d;
              const uy = dy / d;
              for (let e = 0; e < nEyes; e++) {
                if (ux * eyeX[e] + uy * eyeY[e] > EYE_COS) {
                  seen = true;
                  break;
                }
              }
              if (!seen) continue;
            }
            if (gap < bestGap || gap < kinGap) {
              const ks = kinship(sig, i, j);
              if (ks > 0.5) {
                if (gap < kinGap) {
                  kinGap = gap;
                  kdx = dx;
                  kdy = dy;
                  kd = d;
                  kin = j;
                }
              } else if (gap < bestGap) {
                bestGap = gap;
                best = j;
                bestKin = ks;
                bdx = dx;
                bdy = dy;
                bd = d;
              }
            }
          }
        }
      }
    }

    // ---- the smell of detritus ------------------------------------------------
    let fx = 0;
    let fy = 0;
    let fsum = 0;
    if (wet) {
      const pr = range;
      const cx0 = PG.cellX(ox - pr);
      const cx1 = PG.cellX(ox + pr);
      const cy0 = PG.cellY(oy - pr);
      const cy1 = PG.cellY(oy + pr);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const c = cy * PG.cols + cx;
          for (let k = PG.start[c]; k < PG.start[c + 1]; k++) {
            const pi = PG.items[k];
            const pc = P.c[pi];
            if (pc <= 0) continue;
            const dx = P.x[pi] - ox;
            const dy = P.y[pi] - oy;
            const d2 = dx * dx + dy * dy;
            if (d2 > pr * pr) continue;
            const d = Math.sqrt(d2) + 1e-6;
            const wgt = pc / (d + 4);
            fx += (dx / d) * wgt;
            fy += (dy / d) * wgt;
            fsum += wgt;
          }
        }
      }
    }

    // ---- senses → the brain's inputs (the ones that depend on the surroundings) ----
    const o = i * NI;
    b.touch[i] = touching;
    inp[o + IN.Touch] = touching > 0 ? 1 : 0;
    inp[o + IN.Light] = L;
    inp[o + IN.TempDev] = Math.max(-1, Math.min(1, (T - b.tempOpt[i]) / (b.tempTol[i] * 2)));
    inp[o + IN.Oxygen] = O2 / CHEM.O2_EQ;
    inp[o + IN.Sulfide] = Math.min(1, S / 6);
    inp[o + IN.Nutrients] = Math.min(1, NU / 0.4);
    inp[o + IN.Depth] = oy / WORLD_H;
    if (fsum > 0) {
      const inv = 1 / Math.sqrt(fx * fx + fy * fy + 1e-9);
      const strength = Math.tanh(fsum * 0.6);
      inp[o + IN.FoodFwd] = (fx * hx + fy * hy) * inv * strength;
      inp[o + IN.FoodSide] = (-fx * hy + fy * hx) * inv * strength;
    } else {
      inp[o + IN.FoodFwd] = 0;
      inp[o + IN.FoodSide] = 0;
    }
    if (best >= 0) {
      const prox = 1 - Math.max(0, Math.min(1, bestGap / range));
      inp[o + IN.CellFwd] = ((bdx * hx + bdy * hy) / bd) * prox;
      inp[o + IN.CellSide] = ((-bdx * hy + bdy * hx) / bd) * prox;
      inp[o + IN.CellSize] = Math.tanh(Math.log(br[best] / orad) * 1.5);
      inp[o + IN.CellKin] = bestKin;
      inp[o + IN.CellThreat] = threat[best];
      inp[o + IN.CellGlow] = glow[best];
      inp[o + IN.CellGreen] = green[best];
    } else {
      inp[o + IN.CellFwd] = 0;
      inp[o + IN.CellSide] = 0;
      inp[o + IN.CellSize] = 0;
      inp[o + IN.CellKin] = 0;
      inp[o + IN.CellThreat] = 0;
      inp[o + IN.CellGlow] = 0;
      inp[o + IN.CellGreen] = 0;
    }
    if (kin >= 0) {
      const prox = 1 - Math.max(0, Math.min(1, kinGap / range));
      inp[o + IN.KinFwd] = ((kdx * hx + kdy * hy) / kd) * prox;
      inp[o + IN.KinSide] = ((-kdx * hy + kdy * hx) / kd) * prox;
      inp[o + IN.KinGlow] = glow[kin];
      // a courting relative is visible (a courtship display)
      inp[o + IN.MateNear] = court[kin] ? prox : 0;
    } else {
      inp[o + IN.KinFwd] = 0;
      inp[o + IN.KinSide] = 0;
      inp[o + IN.KinGlow] = 0;
      inp[o + IN.MateNear] = 0;
    }
    // chemotaxis: compare the water just ahead with just behind (sharper with sense organs)
    const acuity = b.acuity[i];
    if (wet) {
      const gd = orad + 12;
      const ia = F.cellIndex(ox + hx * gd, oy + hy * gd);
      const ib = F.cellIndex(ox - hx * gd, oy - hy * gd);
      inp[o + IN.LightGrad] = clamp1(((F.light[ia] - F.light[ib]) / (L + 0.05)) * 2) * acuity;
      inp[o + IN.NutGrad] = clamp1(((F.nut[ia] - F.nut[ib]) / (NU + 0.02)) * 2) * acuity;
      inp[o + IN.SulfGrad] = Math.tanh((F.sulf[ia] - F.sulf[ib]) * 0.8) * acuity;
      // pheromones: how strong, and stronger ahead or behind?
      inp[o + IN.SigA] = Math.tanh(F.sigA[ci] * 2);
      inp[o + IN.SigB] = Math.tanh(F.sigB[ci] * 2);
      inp[o + IN.SigAGrad] = Math.tanh((F.sigA[ia] - F.sigA[ib]) * 4) * acuity;
      inp[o + IN.SigBGrad] = Math.tanh((F.sigB[ia] - F.sigB[ib]) * 4) * acuity;
    } else {
      // on land: soil richness ahead vs behind
      const d = hx >= 0 ? 2 : -2;
      const na = soil.nutrient[Math.max(0, Math.min(soil.nutrient.length - 1, col + d))];
      const nb = soil.nutrient[Math.max(0, Math.min(soil.nutrient.length - 1, col - d))];
      inp[o + IN.LightGrad] = 0;
      inp[o + IN.NutGrad] = clamp1(((na - nb) / (NU + 0.05)) * 2) * acuity;
      inp[o + IN.SulfGrad] = 0;
      inp[o + IN.SigA] = 0;
      inp[o + IN.SigB] = 0;
      inp[o + IN.SigAGrad] = 0;
      inp[o + IN.SigBGrad] = 0;
    }
    inp[o + IN.Rain] = Math.min(1, air.rain[ac] * 3);
  }
}

/**
 * Think for organisms [from, to) whose brains live in the shared arena: feed each its inputs from
 * the board, run it, and let it learn from its latest reward. (Others are run by the simulation
 * thread.) Like senseRange, disjoint ranges can run on different threads at once.
 */
export function thinkRange(b: LifeBoard, F: Float32Array, I: Int32Array, slotWords: number, from: number, to: number) {
  const inp = b.inp;
  for (let i = from; i < to; i++) {
    const slot = b.slot[i];
    if (slot < 0 || !b.alive[i]) continue;
    const base = slot * slotWords;
    const oV = valuesAt(I, base);
    for (let k = 0; k < NI; k++) F[oV + k] = inp[i * NI + k];
    stepBrain(F, I, base);
    if (b.learnRate[i] > 0) learnBrain(F, I, base, b.reward[i], b.learnRate[i], DT);
  }
}
