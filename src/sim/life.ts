import { qsat } from './atmosphere';
import { A, CT, IN, OUT, crossover, genomeDistance, mutate, signatureKin } from './genome';
import { MAXC, Organism } from './organism';
import { BIO, CHEM, DT, MAX_ORGS, SKY_H, WORLD_H, WORLD_W } from './params';
import type { World } from './world';

const TWO_PI = Math.PI * 2;
/** Eyes see within ±72° of the direction they face. */
const EYE_COS = 0.3;

const eyeX = new Float32Array(MAXC);
const eyeY = new Float32Array(MAXC);

/** One tick of life: sense → think → act → metabolise → grow → reproduce / die. */
export function stepLife(w: World) {
  const orgs = w.orgs;
  const n = orgs.length;
  for (let i = 0; i < n; i++) {
    const o = orgs[i];
    o.updateWorldCells();
    let top = o.y - o.radius;
    if (o.nCells > 1) for (let c = 0; c < o.nCells; c++) top = Math.min(top, o.wy[c] - o.cellR(c));
    o.topY = top;
  }
  const births: Organism[] = [];
  for (let i = 0; i < n; i++) {
    const o = orgs[i];
    if (!o.dead) updateOrganism(w, o, i, births);
  }
  collide(w, n);
  move(w);
  w.commitBirthsAndDeaths(births);
}

/** Index of o's mouth cell touching q, or -1. */
function mouthContact(o: Organism, q: Organism): number {
  for (let m = 0; m < o.nMouths; m++) {
    const c = o.mouths[m];
    const mx = o.wx[c];
    const my = o.wy[c];
    const rm = o.cellR(c) + 0.8;
    for (let j = 0; j < q.nCells; j++) {
      const dx = q.wx[j] - mx;
      const dy = q.wy[j] - my;
      const r = rm + q.cellR(j);
      if (dx * dx + dy * dy < r * r) return c;
    }
  }
  return -1;
}

/** Exchange gas with the atmosphere (used by life on land). */
function toAir(w: World, co2: number, o2: number) {
  const F = w.fields;
  F.atmCO2 = Math.max(0, F.atmCO2 + co2 / (CHEM.ATM_CELLS * CHEM.CO2_EQ));
  F.atmO2 = Math.max(0, F.atmO2 + o2 / (CHEM.ATM_CELLS * CHEM.O2_EQ));
}

/** Respired carbon goes to the water around a sea creature, or to the air on land. */
function release(w: World, o: Organism, ci: number, co2: number) {
  if (o.onLand) toAir(w, co2, 0);
  else w.fields.co2[ci] += co2;
}

function updateOrganism(w: World, o: Organism, idx: number, births: Organism[]) {
  const F = w.fields;
  const g = o.genome;
  const fr = o.frac;
  const orgs = w.orgs;
  const soil = w.soil;
  const air = w.atmosphere;
  const ci = F.cellIndex(o.x, o.y);
  const col = soil.column(o.x);
  const ac = air.column(o.x);
  // in the sea, or out of it (beach at low tide, or inland)?
  const wet = o.y > F.seaLevel && w.terrain.floorY(o.x) > F.seaLevel;
  o.onLand = !wet;
  let T: number;
  let O2: number;
  let CO2: number;
  let NU: number;
  let S: number;
  let L: number;
  if (wet) {
    T = F.temp[ci];
    O2 = F.o2[ci];
    CO2 = F.co2[ci];
    NU = F.nut[ci];
    S = F.sulf[ci];
    L = F.light[ci];
  } else {
    T = soil.temp[col] * 0.6 + air.surfaceAirT(o.x) * 0.4;
    O2 = F.atmO2 * CHEM.O2_EQ;
    CO2 = F.atmCO2 * CHEM.CO2_EQ;
    NU = soil.nutrient[col] * Math.min(1, soil.moisture[col] * 1.5);
    S = 0;
    L = w.sunNow * (1 - 0.7 * air.shade[ac]) * soil.lightAt(col, o.topY, fr[A.chloro] * o.mass);
  }

  const hx = Math.cos(o.heading);
  const hy = Math.sin(o.heading);
  // side vector (clockwise on screen): (-hy, hx)
  const range = o.sense;
  // the core senses all around (chemoreception); eye cells extend sight only in the directions they face
  const nearRange = o.radius + BIO.SENSE_BASE + 8 + BIO.SENSE_RANGE * o.coreFrac[A.sensor] * o.share[0];
  const nEyes = o.nEyes;
  for (let e = 0; e < nEyes; e++) {
    eyeX[e] = Math.cos(o.heading + o.eyeAngle[e]);
    eyeY[e] = Math.sin(o.heading + o.eyeAngle[e]);
  }
  if (o.digesting > 0) o.digesting -= DT;
  // a full cell is not hungry (satiation limits overkill)
  const canEat = o.eating && o.nMouths > 0 && o.energy < 0.85 * o.ecap;

  // ---- neighbouring organisms ---------------------------------------------
  const G = w.orgGrid;
  // nearest unrelated organism (prey / threat) and nearest relative, tracked separately
  let best: Organism | null = null;
  let bestGap = 1e9;
  let bestKin = 0;
  let bdx = 0;
  let bdy = 0;
  let bd = 1;
  let kinGap = 1e9;
  let kdx = 0;
  let kdy = 0;
  let kd = 1;
  let kinQ: Organism | null = null;
  let touching = 0;
  // a courting organism looks for a courting partner close enough to exchange gametes with
  const courting = o.courting > 0;
  let mate: Organism | null = null;
  {
    const cx0 = G.cellX(o.x - range);
    const cx1 = G.cellX(o.x + range);
    const cy0 = G.cellY(o.y - range);
    const cy1 = G.cellY(o.y + range);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * G.cols + cx;
        for (let k = G.start[c]; k < G.start[c + 1]; k++) {
          const j = G.items[k];
          if (j === idx) continue;
          const q = orgs[j];
          if (q.dead) continue;
          const dx = q.x - o.x;
          const dy = q.y - o.y;
          const d2 = dx * dx + dy * dy;
          const reach = range + q.radius;
          if (d2 > reach * reach) continue;
          const d = Math.sqrt(d2) + 1e-6;
          const gap = d - o.radius - q.radius;
          if (courting && mate === null && q.courting > 0 && gap < BIO.MATE_GAP && genomeDistance(g, q.genome) < BIO.MATE_DIST) {
            mate = q;
          }
          if (gap < 0.8) {
            touching++;
            // innate kin recognition: close relatives are spared unless starving
            if (canEat && (o.energy < 0.25 * o.ecap || signatureKin(g, q.genome) < 0.7)) {
              const mouth = o.digesting <= 0 ? mouthContact(o, q) : -1;
              if (mouth >= 0) {
                // swallow prey that fits in the mouth; take bites out of anything bigger
                if (canSwallow(o, q, mouth)) {
                  if (tryEngulf(w, o, q, mouth, ci)) continue;
                } else {
                  tryBite(w, o, q, mouth, ci);
                  if (q.dead) continue;
                }
              }
            }
          }
          // can it be seen?
          if (nEyes > 0 && d - q.radius > nearRange) {
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
            const kin = signatureKin(g, q.genome);
            if (kin > 0.5) {
              if (gap < kinGap) {
                kinGap = gap;
                kdx = dx;
                kdy = dy;
                kd = d;
                kinQ = q;
              }
            } else if (gap < bestGap) {
              bestGap = gap;
              best = q;
              bestKin = kin;
              bdx = dx;
              bdy = dy;
              bd = d;
            }
          }
        }
      }
    }
  }

  // ---- detritus: smell it, and eat what a mouth touches --------------------
  const P = w.particles;
  const PG = w.partGrid;
  let fx = 0;
  let fy = 0;
  let fsum = 0;
  let bite = o.eating && o.nMouths > 0 ? BIO.BITE * fr[A.mouth] * o.mass * DT : 0;
  if (!wet && bite > 0) {
    // land scavengers eat humus (dead organic matter in the soil)
    const take = Math.min(bite * 0.5, soil.organic[col] * 0.05);
    if (take > 0) {
      soil.organic[col] -= take;
      const gain = take * (0.35 + 0.3 * fr[A.mouth]);
      o.energy += gain;
      o.eFood += gain;
      toAir(w, take - gain, 0);
      o.nutrient += take * BIO.NUT_RATIO * 0.5;
    }
    bite = 0;
  }
  if (wet) {
    const pr = range;
    const cx0 = PG.cellX(o.x - pr);
    const cx1 = PG.cellX(o.x + pr);
    const cy0 = PG.cellY(o.y - pr);
    const cy1 = PG.cellY(o.y + pr);
    const reachR = o.radius + 2;
    const single = o.nCells === 1;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * PG.cols + cx;
        for (let k = PG.start[c]; k < PG.start[c + 1]; k++) {
          const pi = PG.items[k];
          const pc = P.c[pi];
          if (pc <= 0) continue;
          const dx = P.x[pi] - o.x;
          const dy = P.y[pi] - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > pr * pr) continue;
          const d = Math.sqrt(d2) + 1e-6;
          const wgt = pc / (d + 4);
          fx += (dx / d) * wgt;
          fy += (dy / d) * wgt;
          fsum += wgt;
          if (bite > 0 && d < reachR) {
            let reached = single;
            if (!single) {
              for (let m = 0; m < o.nMouths && !reached; m++) {
                const mc = o.mouths[m];
                const ex = P.x[pi] - o.wx[mc];
                const ey = P.y[pi] - o.wy[mc];
                const rr = o.cellR(mc) + 2;
                reached = ex * ex + ey * ey < rr * rr;
              }
            }
            if (!reached) continue;
            const take = Math.min(bite, pc);
            const part = take / pc;
            const nuT = P.nu[pi] * part;
            P.c[pi] = pc - take;
            P.nu[pi] -= nuT;
            bite -= take;
            const eff = 0.4 + 0.35 * fr[A.mouth];
            const gain = take * eff;
            o.energy += gain;
            o.eFood += gain;
            F.co2[ci] += take - gain;
            o.nutrient += nuT;
          }
        }
      }
    }
  }

  // ---- senses → brain ------------------------------------------------------
  const inp = o.brain.inputs;
  inp[IN.Bias] = 1;
  inp[IN.Energy] = o.energy / o.ecap;
  inp[IN.Health] = o.health;
  inp[IN.Size] = o.mass / g.divMass;
  inp[IN.Clock] = Math.sin(o.age * g.oscFreq * TWO_PI);
  inp[IN.Touch] = touching > 0 ? 1 : 0;
  inp[IN.Light] = L;
  inp[IN.UpFwd] = -hy;
  inp[IN.UpSide] = -hx;
  inp[IN.Depth] = o.y / WORLD_H;
  inp[IN.TempDev] = Math.max(-1, Math.min(1, (T - g.tempOpt) / (g.tempTol * 2)));
  inp[IN.Oxygen] = O2 / CHEM.O2_EQ;
  inp[IN.Sulfide] = Math.min(1, S / 6);
  inp[IN.Nutrients] = Math.min(1, NU / 0.4);
  if (fsum > 0) {
    const inv = 1 / Math.sqrt(fx * fx + fy * fy + 1e-9);
    const strength = Math.tanh(fsum * 0.6);
    inp[IN.FoodFwd] = (fx * hx + fy * hy) * inv * strength;
    inp[IN.FoodSide] = (-fx * hy + fy * hx) * inv * strength;
  } else {
    inp[IN.FoodFwd] = 0;
    inp[IN.FoodSide] = 0;
  }
  if (best) {
    const prox = 1 - Math.max(0, Math.min(1, bestGap / range));
    inp[IN.CellFwd] = ((bdx * hx + bdy * hy) / bd) * prox;
    inp[IN.CellSide] = ((-bdx * hy + bdy * hx) / bd) * prox;
    inp[IN.CellSize] = Math.tanh(Math.log(best.radius / o.radius) * 1.5);
    inp[IN.CellKin] = bestKin;
    inp[IN.CellThreat] = Math.min(1, best.frac[A.mouth] * 2.2);
    inp[IN.CellGlow] = best.glow;
    inp[IN.CellGreen] = Math.min(1, best.frac[A.chloro] * 2);
  } else {
    inp[IN.CellFwd] = 0;
    inp[IN.CellSide] = 0;
    inp[IN.CellSize] = 0;
    inp[IN.CellKin] = 0;
    inp[IN.CellThreat] = 0;
    inp[IN.CellGlow] = 0;
    inp[IN.CellGreen] = 0;
  }
  if (kinQ) {
    const prox = 1 - Math.max(0, Math.min(1, kinGap / range));
    inp[IN.KinFwd] = ((kdx * hx + kdy * hy) / kd) * prox;
    inp[IN.KinSide] = ((-kdx * hy + kdy * hx) / kd) * prox;
    inp[IN.KinGlow] = kinQ.glow;
    // a courting relative is visible (a courtship display)
    inp[IN.MateNear] = kinQ.courting > 0 ? prox : 0;
  } else {
    inp[IN.KinFwd] = 0;
    inp[IN.KinSide] = 0;
    inp[IN.KinGlow] = 0;
    inp[IN.MateNear] = 0;
  }
  inp[IN.Ready] = courting ? 1 : 0;
  inp[IN.Pain] = o.pain;
  // chemotaxis: compare the water just ahead with just behind (sharper with sense organs)
  {
    const acuity = Math.min(1, 0.25 + 5 * fr[A.sensor]);
    const clamp1 = (v: number) => (v > 1 ? 1 : v < -1 ? -1 : v);
    if (wet) {
      const gd = o.radius + 12;
      const ia = F.cellIndex(o.x + hx * gd, o.y + hy * gd);
      const ib = F.cellIndex(o.x - hx * gd, o.y - hy * gd);
      inp[IN.LightGrad] = clamp1(((F.light[ia] - F.light[ib]) / (L + 0.05)) * 2) * acuity;
      inp[IN.NutGrad] = clamp1(((F.nut[ia] - F.nut[ib]) / (NU + 0.02)) * 2) * acuity;
      inp[IN.SulfGrad] = Math.tanh((F.sulf[ia] - F.sulf[ib]) * 0.8) * acuity;
      // pheromones: how strong, and stronger ahead or behind?
      inp[IN.SigA] = Math.tanh(F.sigA[ci] * 2);
      inp[IN.SigB] = Math.tanh(F.sigB[ci] * 2);
      inp[IN.SigAGrad] = Math.tanh((F.sigA[ia] - F.sigA[ib]) * 4) * acuity;
      inp[IN.SigBGrad] = Math.tanh((F.sigB[ia] - F.sigB[ib]) * 4) * acuity;
    } else {
      // on land: soil richness ahead vs behind, and which way is uphill (towards the sea is downhill)
      const d = hx >= 0 ? 2 : -2;
      const na = soil.nutrient[Math.max(0, Math.min(soil.nutrient.length - 1, col + d))];
      const nb = soil.nutrient[Math.max(0, Math.min(soil.nutrient.length - 1, col - d))];
      inp[IN.LightGrad] = 0;
      inp[IN.NutGrad] = clamp1(((na - nb) / (NU + 0.05)) * 2) * acuity;
      inp[IN.SulfGrad] = 0;
      inp[IN.SigA] = 0;
      inp[IN.SigB] = 0;
      inp[IN.SigAGrad] = 0;
      inp[IN.SigBGrad] = 0;
    }
  }
  inp[IN.InWater] = wet ? 1 : 0;
  inp[IN.Hydration] = o.hydration;
  inp[IN.Rain] = Math.min(1, air.rain[ac] * 3);
  o.touching = touching;

  o.brain.step();
  o.thrust = Math.max(0, o.brain.output(OUT.Thrust));
  o.turn = o.brain.output(OUT.Turn);
  o.eating = o.brain.output(OUT.Eat) > 0 && o.nMouths > 0;
  const floatTarget = (o.brain.output(OUT.Float) + 1) * 0.5;
  o.glow = Math.max(0, o.brain.output(OUT.Glow));
  o.emitA = Math.max(0, o.brain.output(OUT.EmitA));
  o.emitB = Math.max(0, o.brain.output(OUT.EmitB));
  const pw = w.params;
  // pheromones are released into the water around the cell
  if (wet && pw.pheromones > 0.01 && o.emitA + o.emitB > 0) {
    F.sigA[ci] += BIO.SIG_EMIT * o.emitA * DT;
    F.sigB[ci] += BIO.SIG_EMIT * o.emitB * DT;
  }

  // ---- learning: reward = food intake better (or worse) than expected, minus pain ----
  {
    const total = o.eLight + o.eChem + o.eFood + o.ePrey;
    const gain = (total - o.intakeMark) / (o.mass * DT);
    o.intakeMark = total;
    o.gainFast += (gain - o.gainFast) * Math.min(1, DT / 0.5);
    o.gainSlow += (gain - o.gainSlow) * (DT / 10);
    const surprise = (o.gainFast - o.gainSlow) / (Math.abs(o.gainSlow) + 0.02);
    const r = Math.tanh(0.5 * surprise) - o.pain;
    o.reward = r > 1 ? 1 : r < -1 ? -1 : r;
    if (g.learn > 0 && pw.learning > 0) o.brain.learn(o.reward, g.learn * pw.learning, DT);
  }

  // ---- metabolism ----------------------------------------------------------
  const tempRate = Math.min(2, Math.max(0.5, Math.exp(0.0693147 * (T - 20)))); // Q10 = 2
  const dev = (T - g.tempOpt) / g.tempTol;
  const enzyme = Math.exp(-0.5 * dev * dev);
  const drive = o.thrust * fr[A.flagella];
  let upkeep = o.upkeepK * o.mass * tempRate + o.brainCost;
  upkeep += BIO.THRUST_COST * drive * drive * o.mass;
  if (o.eating) upkeep += BIO.MOUTH_OPEN_COST * o.mass;
  upkeep += BIO.GLOW_COST * o.glow * o.mass;
  upkeep += BIO.SIG_COST * (o.emitA + o.emitB) * o.mass;
  const aer = O2 / (O2 + 1.5);
  const burn = upkeep * (2 - aer) * DT; // fermentation (no O₂) is half as efficient
  o.energy -= burn;
  if (wet) {
    F.co2[ci] += burn;
    F.o2[ci] = Math.max(0, F.o2[ci] - burn * aer);
  } else toAir(w, burn, -burn * aer);

  // water balance: out of the sea, cells dry out unless protected (cuticle, shell) or rooted in moist soil
  if (wet) o.hydration = Math.min(1, o.hydration + 0.5 * DT);
  else {
    const protect = Math.min(1, fr[A.root] * 2.2 + fr[A.armor] * 0.7 + fr[A.storage] * 0.2);
    const gc = air.groundCell(ac);
    const rh = gc >= 0 ? Math.min(1, air.hum[gc] / qsat(air.temp[gc])) : 0.5;
    const loss = BIO.DRY_RATE * (1 - 0.92 * protect) * (0.5 + Math.max(0, T) / 25) * (1.25 - rh);
    const moist = Math.min(1, soil.moisture[col]);
    const gain = (fr[A.root] * 0.6 + 0.02) * moist + air.rain[ac] * 0.6;
    o.hydration = Math.max(0, Math.min(1, o.hydration + (gain - loss) * DT));
    soil.moisture[col] = Math.max(0, soil.moisture[col] - gain * DT * 0.004 * o.mass);
  }

  // photosynthesis: CO₂ + light → sugar + O₂
  if (fr[A.chloro] > 0.01) {
    if (wet) F.shade[ci] += fr[A.chloro] * o.mass;
    else {
      soil.cover[col] += fr[A.chloro] * o.mass;
      if (o.topY < soil.coverTop[col]) soil.coverTop[col] = o.topY;
    }
    if (L > 0.002) {
      const rate = BIO.PHOTO * fr[A.chloro] * o.mass * L * (CO2 / (CO2 + 4)) * enzyme * (wet ? 1 : o.hydration);
      if (wet) {
        const amt = Math.min(rate * DT, F.co2[ci] * 0.5);
        o.energy += amt;
        o.eLight += amt;
        F.co2[ci] -= amt;
        F.o2[ci] += amt;
      } else {
        const amt = rate * DT;
        o.energy += amt;
        o.eLight += amt;
        toAir(w, -amt, amt);
      }
    }
  }
  // chemosynthesis: sulfide + CO₂ → sugar
  if (wet && fr[A.chemo] > 0.01 && S > 0.01) {
    const rate = BIO.CHEMO * fr[A.chemo] * o.mass * (S / (S + 2)) * enzyme;
    const amt = Math.min(rate * DT, F.sulf[ci], F.co2[ci] * 0.5);
    o.energy += amt;
    o.eChem += amt;
    F.sulf[ci] -= amt * 0.5;
    F.co2[ci] -= amt;
  }
  // nutrient uptake: through the membrane in the sea, through roots from the soil on land
  const ncap = o.mass * BIO.NUT_RATIO * 1.5;
  if (o.nutrient < ncap && NU > 0) {
    if (wet) {
      const up = Math.min(BIO.UPTAKE * o.radius * NU * DT, F.nut[ci] * 0.3, ncap - o.nutrient);
      o.nutrient += up;
      F.nut[ci] -= up;
    } else {
      // roots reach the neighbouring soil columns too
      const reachCols = 1 + Math.min(3, Math.floor(o.radius / 8));
      const each = (BIO.UPTAKE * (0.2 + 4 * fr[A.root]) * o.radius * NU * DT) / (2 * reachCols + 1);
      for (let d = -reachCols; d <= reachCols && o.nutrient < ncap; d++) {
        const c = Math.max(0, Math.min(soil.nutrient.length - 1, col + d));
        const up = Math.min(each, soil.nutrient[c] * 0.3, ncap - o.nutrient);
        o.nutrient += up;
        soil.nutrient[c] -= up;
      }
    }
  } else if (o.nutrient > ncap) {
    if (wet) F.nut[ci] += o.nutrient - ncap;
    else soil.nutrient[col] += o.nutrient - ncap;
    o.nutrient = ncap;
  }
  // energy beyond storage capacity is respired away
  if (o.energy > o.ecap) {
    release(w, o, ci, o.energy - o.ecap);
    o.energy = o.ecap;
  }

  // growth: sugar + nutrients → body
  // (keeps half the energy store as a reserve for the night / lean times)
  if (o.energy > 0.5 * o.ecap && o.nutrient > 0 && o.mass < g.divMass * 1.05) {
    let dm = BIO.GROWTH * o.mass * enzyme * DT;
    dm = Math.min(dm, (o.energy - 0.5 * o.ecap) / (1 + BIO.GROWTH_COST), o.nutrient / BIO.NUT_RATIO);
    if (dm > 0) {
      o.mass += dm;
      o.energy -= dm * (1 + BIO.GROWTH_COST);
      release(w, o, ci, dm * BIO.GROWTH_COST);
      o.nutrient -= dm * BIO.NUT_RATIO;
      o.updateSize();
      o.develop();
    }
  }

  // health
  let dmg = 0;
  let dmgCause = '';
  const tdev = Math.abs(T - g.tempOpt) - g.tempTol;
  if (tdev > 0) {
    dmg += 0.012 * tdev;
    dmgCause = T > g.tempOpt ? 'Overheated' : 'Froze';
  }
  if (S > 0.6) {
    const tox = 0.05 * (S - 0.6) * (1 - o.resist);
    if (tox > dmg) dmgCause = 'Sulfide poisoning';
    dmg += tox;
  }
  if (o.energy <= 0.02 * o.ecap) {
    dmg += 0.15;
    dmgCause = 'Starved';
  }
  if (o.hydration < 0.3) {
    const d = 0.5 * (0.3 - o.hydration);
    if (d > dmg) dmgCause = 'Dried out';
    dmg += d;
  }
  if (dmg > 0) {
    o.health -= dmg * DT;
    o.pain = Math.min(1, o.pain + dmg * DT * 25);
  } else if (o.health < 1 && o.energy > 0.4 * o.ecap) {
    o.health = Math.min(1, o.health + 0.05 * DT);
    const c = 0.006 * o.mass * DT;
    o.energy -= c;
    release(w, o, ci, c);
  }
  o.pain *= 1 - 2 * DT;
  o.age += DT;
  o.sinceMating += DT;

  if (o.energy <= 0 && o.health > 0) {
    // catabolism: burn body mass to survive a little longer
    const need = -o.energy + 0.01 * o.mass;
    o.mass -= need;
    o.energy += need;
    o.nutrient += need * BIO.NUT_RATIO;
    if (o.mass < 0.5) {
      w.kill(o, 'Starved');
      return;
    }
    o.updateSize();
    o.develop();
  }
  if (o.health <= 0) {
    w.kill(o, dmgCause || 'Illness');
    return;
  }
  // multicellular bodies renew their cells, so they live a little longer
  if (o.age > g.lifespan * (1 + 0.12 * g.body.length)) {
    w.kill(o, 'Old age');
    return;
  }

  // ---- reproduction: divide alone, or court a mate first --------------------
  if (o.mass < g.divMass || o.energy <= 0.5 * o.ecap || w.orgs.length + births.length >= MAX_ORGS) o.courting = 0;
  else {
    // rooted land plants cannot touch: pollen carries on the wind to a flowering neighbour
    if (courting && !mate && !wet && isRooted(o) && w.rng.chance(0.1)) mate = findPollinator(w, o, idx);
    if (mate && !mate.dead) {
      reproduce(w, o, births, mate);
      // the partner is fertilised too (both were ready); otherwise it just spends its gametes
      const q = mate;
      if (q.mass >= q.genome.divMass && q.energy > 0.5 * q.ecap && w.orgs.length + births.length < MAX_ORGS) {
        reproduce(w, q, births, o);
      } else {
        const c = BIO.GAMETE_COST * q.mass;
        q.energy -= c;
        release(w, q, F.cellIndex(q.x, q.y), c);
        q.sinceMating = 0;
      }
      w.onMating(o, q);
    } else if (g.sex > 0.01 && o.courting < g.sex * BIO.MATE_WAIT) o.courting += DT;
    else reproduce(w, o, births, null);
  }

  // ---- motion (velocity; position is integrated after collisions) ---------
  if (!wet) {
    landMotion(w, o, drive, floatTarget);
    return;
  }
  F.sampleVel(o.x, o.y);
  const drag = BIO.DRAG * pw.viscosity * (1 + 0.6 * fr[A.armor]);
  const speed = (BIO.SPEED * drive) / drag;
  o.inflate += (floatTarget - o.inflate) * Math.min(1, DT * 0.8);
  const density = 0.025 + 0.05 * fr[A.armor] + 0.02 * fr[A.storage] - fr[A.vacuole] * o.inflate * 0.5;
  const sink = (BIO.SINK * density * o.radius * pw.gravity) / drag;
  const tvx = F.su + hx * speed;
  const tvy = F.sv + hy * speed + sink;
  const k = Math.min(1, DT * 8);
  o.vx += (tvx - o.vx) * k;
  o.vy += (tvy - o.vy) * k;
  // Brownian jitter: small cells tumble more
  const rng = w.rng;
  const jitter = (rng.next() + rng.next() + rng.next() - 1.5) * 1.8; // ~N(0, 0.9)
  o.heading += (o.turn * (1.2 + 3 * fr[A.flagella]) + jitter / Math.sqrt(o.radius)) * DT;
  if (o.heading > Math.PI) o.heading -= TWO_PI;
  else if (o.heading < -Math.PI) o.heading += TWO_PI;
}

/** Anchored in the ground by roots (a rooting cuticle or root cells). */
function isRooted(o: Organism): boolean {
  return o.frac[A.root] > 0.12 || o.genome.body.some((c) => c.type === CT.Root);
}

/** A courting land plant within pollen range (further downwind), able to interbreed with o. */
function findPollinator(w: World, o: Organism, idx: number): Organism | null {
  const G = w.orgGrid;
  const wind = w.atmosphere.surfaceWind(o.x);
  const reach = BIO.POLLEN_RANGE + Math.abs(wind) * 3;
  let best: Organism | null = null;
  let bd = reach;
  const cx0 = G.cellX(o.x - reach);
  const cx1 = G.cellX(o.x + reach);
  const cy0 = G.cellY(o.y - reach);
  const cy1 = G.cellY(o.y + reach);
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * G.cols + cx;
      for (let k = G.start[c]; k < G.start[c + 1]; k++) {
        const j = G.items[k];
        if (j === idx) continue;
        const q = w.orgs[j];
        if (q.dead || q.courting <= 0 || !q.onLand) continue;
        const d = Math.hypot(q.x - o.x, q.y - o.y);
        if (d < bd && genomeDistance(o.genome, q.genome) < BIO.MATE_DIST) {
          bd = d;
          best = q;
        }
      }
    }
  }
  return best;
}

/** Movement out of the water: fall, rest on the ground, crawl; rooted plants grow towards the light. */
function landMotion(w: World, o: Organism, drive: number, floatTarget: number) {
  const fr = o.frac;
  const rooted = isRooted(o);
  o.inflate += (floatTarget - o.inflate) * Math.min(1, DT * 0.8);
  if (rooted) {
    // phototropism: the growing tip turns up
    let d = -Math.PI / 2 - o.heading;
    while (d > Math.PI) d -= TWO_PI;
    while (d < -Math.PI) d += TWO_PI;
    o.heading += d * Math.min(1, 2 * DT);
  } else {
    const rng = w.rng;
    const jitter = (rng.next() + rng.next() - 1) * 0.6;
    o.heading += (o.turn * 2 + jitter) * DT;
    if (o.heading > Math.PI) o.heading -= TWO_PI;
    else if (o.heading < -Math.PI) o.heading += TWO_PI;
  }
  // crawling (feet from flagella/motor cells; roots anchor)
  const crawl = rooted ? 0 : (BIO.CRAWL * (drive + 0.05 * o.thrust)) / (1 + 6 * fr[A.root]);
  const tvx = Math.cos(o.heading) >= 0 ? crawl : -crawl;
  const k = Math.min(1, DT * 6);
  o.vx += (tvx - o.vx) * k;
  // gravity (the ground stops the fall in move())
  o.vy = Math.min(90, o.vy + 150 * w.params.gravity * DT);
}

function gapeOf(o: Organism, mouth: number): number {
  return o.nCells === 1 ? o.radius : o.cellR(mouth) * 1.3;
}

/** Prey fits in the mouth: up to about the mouth cell's own size; armour makes it harder. */
function canSwallow(o: Organism, q: Organism, mouth: number): boolean {
  return q.radius / gapeOf(o, mouth) <= 1.15 - 0.5 * q.frac[A.armor];
}

/** Swallow prey whole (probabilistic, per tick of contact). */
function tryEngulf(w: World, o: Organism, q: Organism, mouth: number, ci: number): boolean {
  const armor = q.frac[A.armor];
  const ratio = q.radius / gapeOf(o, mouth);
  const maxRatio = 1.15 - 0.5 * armor;
  const p = BIO.ENGULF * o.frac[A.mouth] * (1 - 0.7 * armor) * Math.min(1, (maxRatio - ratio) * 2.5) * DT;
  if (w.rng.next() > p) return false;
  const carbon = q.mass + q.energy;
  const eff = 0.3 + 0.3 * o.frac[A.mouth]; // gross growth efficiency of protist predators
  const gain = carbon * eff;
  o.energy += gain;
  o.ePrey += gain;
  release(w, o, ci, carbon - gain);
  o.nutrient += q.nutrient + q.mass * BIO.NUT_RATIO;
  o.kills++;
  o.digesting = 3 + q.mass; // handling time: a meal takes a while to digest
  q.dead = true;
  const sp = w.species.get(o.species);
  q.cause = `Eaten by ${sp ? sp.name : 'a predator'} #${o.id}`;
  return true;
}

/** Tear a chunk out of prey too big to swallow. Armour blunts bites; each bite takes time to digest. */
function tryBite(w: World, o: Organism, q: Organism, mouth: number, ci: number) {
  const armor = q.frac[A.armor];
  const power = o.frac[A.mouth] * (o.nCells === 1 ? 1 : 1 + 0.5 * o.share[mouth] * o.nCells);
  if (w.rng.next() > BIO.ENGULF * power * DT) return;
  const chunk = Math.min(q.mass * 0.35, BIO.BITE_PREY * power * o.mass * (1 - 0.8 * armor));
  if (chunk <= 1e-3) return;
  o.digesting = 0.5 + chunk;
  const part = chunk / q.mass;
  const eChunk = Math.max(0, q.energy) * part;
  const nuChunk = q.nutrient * part;
  q.mass -= chunk;
  q.energy -= eChunk;
  q.nutrient -= nuChunk;
  q.health -= part * 1.5;
  q.pain = 1;
  const carbon = chunk + eChunk;
  const eff = 0.3 + 0.3 * o.frac[A.mouth];
  const gain = carbon * eff;
  o.energy += gain;
  o.ePrey += gain;
  release(w, o, ci, carbon - gain);
  o.nutrient += nuChunk + chunk * BIO.NUT_RATIO;
  q.updateSize();
  q.develop();
  if (q.mass < 0.6 || q.health <= 0) {
    const sp = w.species.get(o.species);
    o.kills++;
    w.kill(q, `Eaten by ${sp ? sp.name : 'a predator'} #${o.id}`);
  }
}

/**
 * Single cells split in two; multicellular bodies bud off a small propagule that grows its own body.
 * With a mate, the offspring's genome recombines both parents' genes (then mutates as usual).
 */
function reproduce(w: World, o: Organism, births: Organism[], mate: Organism | null) {
  const rng = w.rng;
  const F = w.fields;
  const cost = 0.04 * o.mass;
  o.energy -= cost;
  release(w, o, F.cellIndex(o.x, o.y), cost);
  o.courting = 0;
  const g2 = mutate(mate ? crossover(o.genome, mate.genome, rng) : o.genome, rng, w.params.mutation);
  const sp = w.species.assign(g2, o.species, w.tick, rng);
  const share = o.genome.body.length > 0 ? 0.3 : 0.5;
  const m = o.mass * share;
  const e = o.energy * share;
  const nu = o.nutrient * share;
  o.mass -= m;
  o.energy -= e;
  o.nutrient -= nu;
  o.updateSize();
  o.develop();
  const child = new Organism(w.nextOrgId++, g2, sp.id, o.generation + 1, o.id, w.tick, m, e, nu);
  const a = rng.next() * TWO_PI;
  const off = (o.radius + child.radius) * 0.5;
  if (o.onLand) {
    // seeds and spores: carried a little way (further on the wind)
    const wind = w.atmosphere.surfaceWind(o.x);
    const dx = (rng.chance(0.5) ? -1 : 1) * (o.radius + child.radius + rng.range(5, 45)) + wind * rng.range(0, 4);
    child.x = Math.max(child.radius, Math.min(WORLD_W - child.radius, o.x + dx));
    child.y = Math.min(o.y, w.terrain.floorY(child.x) - child.radius - 1);
    child.heading = -Math.PI / 2;
    child.hydration = o.hydration;
  } else {
    child.x = o.x + Math.cos(a) * off;
    child.y = o.y + Math.sin(a) * off;
  }
  if (share === 0.5 && !o.onLand) {
    o.x -= Math.cos(a) * off;
    o.y -= Math.sin(a) * off;
  }
  child.vx = o.vx;
  child.vy = o.vy;
  if (!o.onLand) child.heading = a;
  child.health = o.health;
  child.inflate = o.inflate;
  child.updateWorldCells();
  o.children++;
  if (mate) {
    child.father = mate.id;
    o.mates++;
    o.sinceMating = 0;
  }
  w.recordBirth(mate !== null);
  births.push(child);
}

function collide(w: World, n: number) {
  const orgs = w.orgs;
  const G = w.orgGrid;
  const maxR = w.maxRadius;
  for (let i = 0; i < n; i++) {
    const o = orgs[i];
    if (o.dead) continue;
    const reach = o.radius + maxR;
    const cx0 = G.cellX(o.x - reach);
    const cx1 = G.cellX(o.x + reach);
    const cy0 = G.cellY(o.y - reach);
    const cy1 = G.cellY(o.y + reach);
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * G.cols + cx;
        for (let k = G.start[c]; k < G.start[c + 1]; k++) {
          const j = G.items[k];
          if (j <= i) continue;
          const q = orgs[j];
          if (q.dead) continue;
          const dx = q.x - o.x;
          const dy = q.y - o.y;
          const minD = o.radius + q.radius;
          const d2 = dx * dx + dy * dy;
          if (d2 >= minD * minD) continue;
          const tot = o.mass + q.mass;
          if (o.nCells === 1 && q.nCells === 1) {
            const d = Math.sqrt(d2) || 0.01;
            const push = (minD - d) * 0.5;
            const nx = d2 > 0 ? dx / d : 1;
            const ny = d2 > 0 ? dy / d : 0;
            const po = (push * q.mass) / tot;
            const pq = (push * o.mass) / tot;
            o.x -= nx * po;
            o.y -= ny * po;
            q.x += nx * pq;
            q.y += ny * pq;
            continue;
          }
          // multicellular: resolve cell against cell
          for (let a = 0; a < o.nCells; a++) {
            const ra = o.cellR(a);
            for (let b = 0; b < q.nCells; b++) {
              const ex = q.wx[b] - o.wx[a];
              const ey = q.wy[b] - o.wy[a];
              const m = ra + q.cellR(b);
              const e2 = ex * ex + ey * ey;
              if (e2 >= m * m) continue;
              const e = Math.sqrt(e2) || 0.01;
              const push = (m - e) * 0.5;
              const nx = ex / e;
              const ny = ey / e;
              const po = (push * q.mass) / tot;
              const pq = (push * o.mass) / tot;
              o.x -= nx * po;
              o.y -= ny * po;
              q.x += nx * pq;
              q.y += ny * pq;
            }
          }
        }
      }
    }
  }
}

function move(w: World) {
  const t = w.terrain;
  const rocks = t.rocks;
  const sl = w.fields.seaLevel;
  const top = -SKY_H + 10;
  for (const o of w.orgs) {
    if (o.dead) continue;
    const dx = o.vx * DT;
    const dy = o.vy * DT;
    o.x += dx;
    o.y += dy;
    o.travelled += Math.sqrt(dx * dx + dy * dy);
    if (o.nCells === 1) {
      const r = o.radius;
      if (o.x < r) {
        o.x = r;
        o.vx = 0;
      } else if (o.x > WORLD_W - r) {
        o.x = WORLD_W - r;
        o.vx = 0;
      }
      const fy = t.floorY(o.x) - r;
      // swimmers stay under the sea surface where the water is deep enough to hold them
      if (!o.onLand && o.y - r < sl && fy > sl + r) {
        o.y = sl + r;
        if (o.vy < 0) o.vy = 0;
      }
      if (o.y < top) o.y = top;
      if (o.y > fy) {
        o.y = fy;
        if (o.vy > 0) o.vy = 0;
      }
      for (let k = 0; k < rocks.length; k++) {
        const rk = rocks[k];
        const ex = o.x - rk.x;
        const ey = o.y - rk.y;
        const min = rk.r * 0.86 + r;
        const d2 = ex * ex + ey * ey;
        if (d2 < min * min) {
          const d = Math.sqrt(d2) || 0.01;
          o.x = rk.x + (ex / d) * min;
          o.y = rk.y + (ey / d) * min;
        }
      }
      continue;
    }
    // multicellular: keep every cell inside the world and out of the rocks; roots may grow into the soil
    o.updateWorldCells();
    let px0 = 0;
    let px1 = 0;
    let py0 = 0;
    let py1 = 0;
    let rx = 0;
    let ry = 0;
    let submerged = 0;
    for (let i = 0; i < o.nCells; i++) {
      const x = o.wx[i];
      const y = o.wy[i];
      const r = o.cellR(i);
      if (x - r < 0) px0 = Math.max(px0, r - x);
      if (x + r > WORLD_W) px1 = Math.min(px1, WORLD_W - r - x);
      if (y - r < top) py0 = Math.max(py0, top + r - y);
      if (o.ctype[i] === CT.Root) continue;
      const fy = t.floorY(x) - r;
      if (y > fy) py1 = Math.min(py1, fy - y);
      if (!o.onLand && y - r < sl && fy > sl + r) submerged = Math.max(submerged, sl + r - y);
      for (let k = 0; k < rocks.length; k++) {
        const rk = rocks[k];
        const ex = x - rk.x;
        const ey = y - rk.y;
        const min = rk.r * 0.86 + r;
        const d2 = ex * ex + ey * ey;
        if (d2 < min * min) {
          const d = Math.sqrt(d2) || 0.01;
          const pen = min - d;
          rx += (ex / d) * pen;
          ry += (ey / d) * pen;
        }
      }
    }
    if (submerged > 0) py0 = Math.max(py0, submerged);
    const sx = px0 + px1 + rx * 0.5;
    const sy = py0 + py1 + ry * 0.5;
    o.x += sx;
    o.y += sy;
    if (sx !== 0) o.vx = 0;
    if (py0 > 0 && o.vy < 0) o.vy = 0;
    if (py1 < 0 && o.vy > 0) o.vy = 0;
    o.updateWorldCells();
  }
}
