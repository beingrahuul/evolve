import { Fields } from './fields';
import { A, Archetype, Genome, cloneGenome, makeGenome, mutate } from './genome';
import { stepLife } from './life';
import { Organism } from './organism';
import {
  BIO,
  CELL,
  DT,
  FIELD_EVERY,
  GodParams,
  MAX_ORGS,
  MAX_PARTICLES,
  NX,
  NY,
  WORLD_H,
  WORLD_W,
  defaultParams,
} from './params';
import { Particles } from './particles';
import { Rng, clamp } from './rng';
import { SpatialGrid } from './spatial';
import { Species, SpeciesRegistry } from './species';
import { Stats } from './stats';
import { ROCK_TYPES, Terrain } from './terrain';

export type Selection =
  | { kind: 'organism'; id: number }
  | { kind: 'particle'; uid: number }
  | { kind: 'rock'; id: number }
  | { kind: 'vent'; id: number }
  | { kind: 'water'; x: number; y: number }
  | { kind: 'sky'; x: number; y: number }
  | { kind: 'floor'; x: number; y: number };

export type EventKind = 'species' | 'extinct' | 'god' | 'info';

export interface WorldEvent {
  seq: number;
  tick: number;
  text: string;
  kind: EventKind;
}

export type FieldBrush = 'heat' | 'cool' | 'nutrients' | 'sulfide';

const ANNOUNCE_AT = 12;

export class World {
  readonly rng: Rng;
  params: GodParams;
  tick = 0;
  dayPhase = 0.3; // 0 = midnight, 0.5 = noon
  days = 0;
  sunNow = 0;
  sunElev = 0;

  readonly fields = new Fields();
  readonly terrain = new Terrain();
  readonly particles = new Particles();
  orgs: Organism[] = [];
  readonly orgById = new Map<number, Organism>();
  readonly species = new SpeciesRegistry();
  readonly stats = new Stats();
  events: WorldEvent[] = [];
  eventSeq = 0;
  nextOrgId = 1;

  readonly orgGrid = new SpatialGrid(WORLD_W, WORLD_H, 40, MAX_ORGS * 2);
  readonly partGrid = new SpatialGrid(WORLD_W, WORLD_H, 30, MAX_PARTICLES);
  maxRadius = 10;
  private xs = new Float32Array(MAX_ORGS * 2);
  private ys = new Float32Array(MAX_ORGS * 2);

  sediment = { c: 0, nu: 0 };
  totalBorn = 0;
  totalDied = 0;
  deathCauses = new Map<string, number>();
  archSpecies = new Map<Archetype, number>();

  /** `blank` skips world generation (used when restoring a saved world). */
  constructor(
    readonly seed: number,
    params?: GodParams,
    blank = false,
  ) {
    this.rng = new Rng(seed);
    this.params = params ?? defaultParams();
    if (blank) return;
    this.terrain.generate(this.rng);
    this.fields.init(this.terrain);
    this.updateSun();
    // let the water settle a little before life appears
    for (let i = 0; i < 40; i++) {
      this.fields.step(DT * FIELD_EVERY, this.params, this.terrain, this.sunNow, this.rng);
    }
    this.seedSediment();
    this.seedLife(1);
    this.log(`World created from seed ${seed}. Primordial cells stir in the water.`, 'info');
  }

  get time(): number {
    return this.tick * DT;
  }

  /** Hour of the day, 0-24. */
  get hour(): number {
    return this.dayPhase * 24;
  }

  step() {
    this.tick++;
    this.dayPhase += DT / this.params.dayLength;
    if (this.dayPhase >= 1) {
      this.dayPhase -= 1;
      this.days++;
    }
    this.updateSun();
    this.rebuildGrids();
    stepLife(this);
    this.stepParticles();
    this.fields.shadeTicks++;
    if (this.tick % FIELD_EVERY === 0) {
      this.fields.step(DT * FIELD_EVERY, this.params, this.terrain, this.sunNow, this.rng);
    }
    if (this.tick % 60 === 0) {
      this.stats.record(this);
      if (this.params.autoSeed && this.orgs.length < 5 && this.tick % 600 === 0) {
        this.seedLife(0.4);
        this.log('Life re-emerged from the primordial soup.', 'info');
      }
    }
  }

  updateSun() {
    const elev = -Math.cos(this.dayPhase * Math.PI * 2);
    this.sunElev = elev;
    this.sunNow = this.params.sun * (elev > 0 ? Math.pow(elev, 0.7) : 0);
  }

  private rebuildGrids() {
    const n = this.orgs.length;
    if (n > this.xs.length) {
      this.xs = new Float32Array(n * 2);
      this.ys = new Float32Array(n * 2);
    }
    let maxR = 1;
    for (let i = 0; i < n; i++) {
      const o = this.orgs[i];
      this.xs[i] = o.x;
      this.ys[i] = o.y;
      if (o.radius > maxR) maxR = o.radius;
    }
    this.maxRadius = maxR;
    this.orgGrid.build(n, this.xs, this.ys);
    this.partGrid.build(this.particles.n, this.particles.x, this.particles.y);
  }

  // ---------------------------------------------------------------------------
  // Life & death bookkeeping
  // ---------------------------------------------------------------------------

  addOrganism(o: Organism) {
    this.orgs.push(o);
    this.orgById.set(o.id, o);
    const sp = this.species.get(o.species);
    if (sp) {
      sp.count++;
      sp.total++;
      sp.extinct = -1;
      if (sp.count > sp.peak) sp.peak = sp.count;
      if (!sp.announced && sp.count >= ANNOUNCE_AT && sp.total > sp.count) {
        sp.announced = true;
        if (sp.parentId) {
          const parent = this.species.get(sp.parentId);
          this.log(`New species thriving: ${sp.name}${parent ? `, descended from ${parent.name}` : ''}.`, 'species');
        }
      }
    }
    this.totalBorn++;
  }

  /** Called by the life step once per tick. */
  commitBirthsAndDeaths(births: Organism[]) {
    const orgs = this.orgs;
    let wi = 0;
    for (let i = 0; i < orgs.length; i++) {
      const o = orgs[i];
      if (!o.dead) orgs[wi++] = o;
      else this.onRemoved(o);
    }
    orgs.length = wi;
    for (const b of births) this.addOrganism(b);
  }

  private onRemoved(o: Organism) {
    this.orgById.delete(o.id);
    this.totalDied++;
    const cause = o.cause.startsWith('Eaten') ? 'Eaten' : o.cause || 'Unknown';
    this.deathCauses.set(cause, (this.deathCauses.get(cause) ?? 0) + 1);
    const sp = this.species.get(o.species);
    if (sp) {
      sp.count--;
      if (sp.count <= 0) {
        sp.count = 0;
        sp.extinct = this.tick;
        if (sp.peak >= ANNOUNCE_AT) this.log(`${sp.name} went extinct (peak population ${sp.peak}).`, 'extinct');
      }
    }
  }

  /** Kill an organism; its body becomes detritus. */
  kill(o: Organism, cause: string) {
    if (o.dead) return;
    o.dead = true;
    o.cause = cause;
    const carbon = Math.max(0, o.mass + o.energy);
    const nu = o.nutrient + o.mass * BIO.NUT_RATIO;
    const multi = o.nCells > 1;
    const k = multi ? Math.min(o.nCells, 6) : clamp(Math.round(o.mass / 5), 1, 4);
    if (multi) o.updateWorldCells();
    for (let i = 0; i < k; i++) {
      let x: number;
      let y: number;
      if (multi) {
        x = o.wx[i];
        y = o.wy[i];
      } else {
        const a = this.rng.next() * Math.PI * 2;
        const r = this.rng.next() * o.radius * 0.7;
        x = o.x + Math.cos(a) * r;
        y = o.y + Math.sin(a) * r;
      }
      if (!this.particles.add(x, y, carbon / k, nu / k)) {
        const ci = this.fields.cellIndex(x, y);
        this.fields.co2[ci] += carbon / k;
        this.fields.nut[ci] += nu / k;
      }
    }
  }

  private stepParticles() {
    const P = this.particles;
    const F = this.fields;
    const t = this.terrain;
    const sink = BIO.PARTICLE_SINK * this.params.gravity;
    const decayK = BIO.DECAY * this.params.decay;
    for (let i = P.n - 1; i >= 0; i--) {
      let ci = F.cellIndex(P.x[i], P.y[i]);
      if (P.c[i] <= 0.01) {
        F.co2[ci] += Math.max(0, P.c[i]);
        F.nut[ci] += Math.max(0, P.nu[i]);
        P.remove(i);
        continue;
      }
      F.sampleVel(P.x[i], P.y[i]);
      let x = P.x[i] + F.su * DT;
      let y = P.y[i] + (F.sv + sink) * DT;
      if (x < 1) x = 1;
      else if (x > WORLD_W - 1) x = WORLD_W - 1;
      if (y < 1) y = 1;
      const fy = t.floorY(x) - 1.5;
      let resting = false;
      if (y >= fy) {
        y = fy;
        resting = true;
      }
      ci = F.cellIndex(x, y);
      if (F.solid[ci]) {
        const rk = F.rockAt[ci];
        if (rk >= 0 && rk < t.rocks.length) {
          const rock = t.rocks[rk];
          const dx = x - rock.x;
          const dy = y - rock.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const target = rock.r * 0.9 + 1.5;
          if (d < target) {
            x = rock.x + (dx / d) * target;
            y = rock.y + (dy / d) * target;
          }
        }
        resting = true;
        ci = F.cellIndex(x, y);
      }
      P.x[i] = x;
      P.y[i] = y;
      P.age[i] += DT;
      P.rest[i] = resting ? P.rest[i] + DT : 0;

      // bacterial decomposition returns carbon and nutrients to the water
      const T = F.temp[ci];
      const tf = Math.min(2, Math.max(0.3, Math.pow(2, (T - 20) / 10)));
      const o2 = F.o2[ci];
      const aer = o2 / (o2 + 1);
      const rate = decayK * tf * (0.3 + 0.7 * aer) * DT;
      const dc = P.c[i] * rate;
      const dn = P.nu[i] * rate;
      P.c[i] -= dc;
      P.nu[i] -= dn;
      F.co2[ci] += dc;
      F.o2[ci] = Math.max(0, o2 - dc * aer);
      F.nut[ci] += dn;

      // slowly buried in the sediment, leaving the cycle
      if (P.rest[i] > 20 && this.rng.next() < BIO.BURIAL * DT) {
        this.sediment.c += P.c[i];
        this.sediment.nu += P.nu[i];
        P.remove(i);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  /** Primordial organic matter: a starting larder for the first scavengers. */
  seedSediment() {
    const r = this.rng;
    for (let i = 0; i < 450; i++) {
      const x = r.range(10, WORLD_W - 10);
      const y = i < 300 ? this.terrain.floorY(x) - 1.5 : r.range(20, this.terrain.floorY(x) - 5);
      this.particles.add(x, y, r.range(0.8, 2.5), 0.12);
    }
  }

  seedLife(scale: number) {
    const r = this.rng;
    const n = (k: number) => Math.max(1, Math.round(k * scale));
    for (let i = 0; i < n(140); i++) this.spawn('photo', r.range(20, WORLD_W - 20), r.range(15, 260));
    for (const v of this.terrain.vents) {
      for (let i = 0; i < n(12); i++) this.spawn('chemo', v.x + r.range(-60, 60), v.y - r.range(15, 90));
    }
    for (let i = 0; i < n(8); i++) this.spawn('grazer', r.range(20, WORLD_W - 20), r.range(30, 300));
    for (let i = 0; i < n(3); i++) this.spawn('hunter', r.range(20, WORLD_W - 20), r.range(40, 400));
    for (let i = 0; i < n(24); i++) {
      const x = r.range(20, WORLD_W - 20);
      this.spawn('scavenger', x, this.terrain.floorY(x) - r.range(10, 120));
    }
    for (let i = 0; i < n(20); i++) this.spawn('random', r.range(20, WORLD_W - 20), r.range(20, WORLD_H - 150));
    for (let i = 0; i < n(14); i++) this.spawn('colony', r.range(40, WORLD_W - 40), r.range(20, 220));
    for (let i = 0; i < n(2); i++) this.spawn('stalker', r.range(40, WORLD_W - 40), r.range(60, 380));
  }

  /** Create a new organism from an archetype (or a given genome). */
  spawn(arch: Archetype, x: number, y: number, genome?: Genome, speciesId?: number): Organism | null {
    if (this.orgs.length >= MAX_ORGS + 200) return null;
    if (y < 4 || y > this.terrain.floorY(x) - 4) return null;
    const g = genome ? cloneGenome(genome) : makeGenome(this.rng, arch);
    let sp: Species | undefined = speciesId ? this.species.get(speciesId) : undefined;
    if (!sp) {
      const base = arch === 'random' ? undefined : this.archSpecies.get(arch);
      sp = this.species.assign(g, base ?? 0, this.tick, this.rng);
      if (arch !== 'random' && !base) this.archSpecies.set(arch, sp.id);
    }
    const mass = g.divMass * this.rng.range(0.5, 0.8);
    const o = new Organism(this.nextOrgId++, g, sp.id, 0, 0, this.tick, mass, 0, mass * BIO.NUT_RATIO * 0.6);
    o.energy = o.ecap * 0.6;
    o.x = clamp(x, o.radius, WORLD_W - o.radius);
    o.y = y;
    o.heading = this.rng.range(-Math.PI, Math.PI);
    this.addOrganism(o);
    return o;
  }

  clone(o: Organism): Organism | null {
    const a = this.rng.next() * Math.PI * 2;
    const c = this.spawn('random', o.x + Math.cos(a) * o.radius * 2.2, o.y + Math.sin(a) * o.radius * 2.2, o.genome, o.species);
    return c;
  }

  // ---------------------------------------------------------------------------
  // God powers
  // ---------------------------------------------------------------------------

  /** Rewrite an organism's genome with a strong mutation. */
  mutateOrganism(o: Organism, strength = 5) {
    const g = mutate(o.genome, this.rng, strength);
    const old = this.species.get(o.species);
    const sp = this.species.assign(g, o.species, this.tick, this.rng);
    if (sp !== old) {
      if (old) {
        old.count--;
        if (old.count <= 0) {
          old.count = 0;
          old.extinct = this.tick;
        }
      }
      sp.count++;
      sp.total++;
      sp.extinct = -1;
      if (sp.count > sp.peak) sp.peak = sp.count;
      o.species = sp.id;
    }
    o.setGenome(g);
    if (o.mass > g.divMass) o.mass = g.divMass * 0.9;
    o.updateSize();
  }

  log(text: string, kind: EventKind) {
    this.events.push({ seq: ++this.eventSeq, tick: this.tick, text, kind });
    if (this.events.length > 200) this.events.splice(0, this.events.length - 200);
  }

  addFood(x: number, y: number, r: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const d = Math.sqrt(this.rng.next()) * r;
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      if (py < 1 || py > this.terrain.floorY(px)) continue;
      this.particles.add(px, py, this.rng.range(1, 2.5), 0.15);
    }
  }

  paintField(kind: FieldBrush, x: number, y: number, r: number, dt: number) {
    const F = this.fields;
    const i0 = Math.max(0, Math.floor((x - r) / CELL));
    const i1 = Math.min(NX - 1, Math.floor((x + r) / CELL));
    const j0 = Math.max(0, Math.floor((y - r) / CELL));
    const j1 = Math.min(NY - 1, Math.floor((y + r) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * NX + i;
        if (F.solid[idx]) continue;
        const dx = (i + 0.5) * CELL - x;
        const dy = (j + 0.5) * CELL - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) continue;
        const fall = 1 - d / r;
        switch (kind) {
          case 'heat':
            F.temp[idx] = Math.min(110, F.temp[idx] + 40 * fall * dt);
            break;
          case 'cool':
            F.temp[idx] = Math.max(-2, F.temp[idx] - 40 * fall * dt);
            break;
          case 'nutrients':
            F.nut[idx] += 1.2 * fall * dt;
            break;
          case 'sulfide':
            F.sulf[idx] += 12 * fall * dt;
            break;
        }
      }
    }
  }

  pushFlow(x: number, y: number, dx: number, dy: number, r: number) {
    const F = this.fields;
    const i0 = Math.max(0, Math.floor((x - r) / CELL));
    const i1 = Math.min(NX - 1, Math.floor((x + r) / CELL));
    const j0 = Math.max(0, Math.floor((y - r) / CELL));
    const j1 = Math.min(NY - 1, Math.floor((y + r) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * NX + i;
        if (F.solid[idx]) continue;
        const ex = (i + 0.5) * CELL - x;
        const ey = (j + 0.5) * CELL - y;
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d > r) continue;
        const fall = 1 - d / r;
        F.u[idx] += dx * fall;
        F.v[idx] += dy * fall;
      }
    }
  }

  smite(x: number, y: number, r: number): number {
    let n = 0;
    for (const o of this.orgs) {
      if (o.dead) continue;
      const dx = o.x - x;
      const dy = o.y - y;
      if (dx * dx + dy * dy < r * r) {
        this.kill(o, 'Struck down by god');
        n++;
      }
    }
    return n;
  }

  placeRock(x: number, y: number, r: number, typeIndex: number) {
    const type = ROCK_TYPES[clamp(typeIndex, 0, ROCK_TYPES.length - 1)];
    this.terrain.addRock(x, y, r, type, this.rng);
    this.fields.rebuildSolid(this.terrain);
  }

  removeRock(id: number) {
    this.terrain.rocks = this.terrain.rocks.filter((r) => r.id !== id);
    this.fields.rebuildSolid(this.terrain);
  }

  placeVent(x: number) {
    this.terrain.addVent(x, 1);
  }

  removeVent(id: number) {
    this.terrain.vents = this.terrain.vents.filter((v) => v.id !== id);
  }

  meteor() {
    const x = this.rng.range(150, WORLD_W - 150);
    const y = this.terrain.floorY(x) - 20;
    const n = this.smite(x, y, 260);
    this.paintField('heat', x, y, 220, 2);
    this.paintField('nutrients', x, y, 260, 2);
    this.pushFlow(x, y - 100, 0, -40, 260);
    this.addFood(x, y - 60, 160, 60);
    this.log(`A meteor struck the seafloor! ${n} organisms were vaporised; minerals spread through the water.`, 'god');
  }

  massExtinction(frac = 0.9) {
    let n = 0;
    for (const o of this.orgs) {
      if (!o.dead && this.rng.next() < frac) {
        this.kill(o, 'Mass extinction');
        n++;
      }
    }
    this.log(`Mass extinction: ${n} organisms perished.`, 'god');
  }

  nutrientBloom() {
    const F = this.fields;
    for (let idx = 0; idx < NX * NY; idx++) if (!F.solid[idx]) F.nut[idx] += 0.6;
    this.log('Nutrient bloom: the water turns rich with minerals.', 'god');
  }

  volcanicEruption() {
    for (const v of this.terrain.vents) v.power = Math.min(4, v.power * 2 + 0.5);
    this.fields.atmCO2 += 0.5;
    this.log('Volcanic eruption: vents surge and CO₂ pours into the atmosphere.', 'god');
  }

  // ---------------------------------------------------------------------------
  // Picking
  // ---------------------------------------------------------------------------

  pick(x: number, y: number, tol: number): Selection {
    if (y < 0) return { kind: 'sky', x, y };
    // organisms
    let best: Organism | null = null;
    let bd = Infinity;
    for (const o of this.orgs) {
      const d = Math.hypot(o.x - x, o.y - y) - o.radius;
      if (d < tol && d < bd) {
        bd = d;
        best = o;
      }
    }
    if (best) return { kind: 'organism', id: best.id };
    for (const v of this.terrain.vents) {
      if (Math.hypot(v.x - x, v.y - 14 - y) < 28) return { kind: 'vent', id: v.id };
    }
    for (const r of this.terrain.rocks) {
      if (Math.hypot(r.x - x, r.y - y) < r.r * 0.95) return { kind: 'rock', id: r.id };
    }
    const P = this.particles;
    let pi = -1;
    let pd = tol * 0.8;
    for (let i = 0; i < P.n; i++) {
      const d = Math.hypot(P.x[i] - x, P.y[i] - y);
      if (d < pd) {
        pd = d;
        pi = i;
      }
    }
    if (pi >= 0) return { kind: 'particle', uid: P.uid[pi] };
    if (y > this.terrain.floorY(x)) return { kind: 'floor', x, y };
    return { kind: 'water', x, y };
  }

  /** Dominant lifestyle of an organism based on where its energy actually came from. */
  diet(o: Organism): string {
    const tot = o.eLight + o.eChem + o.eFood + o.ePrey;
    if (tot < 0.5) {
      const f = o.frac;
      const m = Math.max(f[A.chloro], f[A.chemo], f[A.mouth]);
      if (m === f[A.chloro]) return 'Phototroph';
      if (m === f[A.chemo]) return 'Chemotroph';
      return 'Heterotroph';
    }
    const parts: [string, number][] = [
      ['Phototroph', o.eLight],
      ['Chemotroph', o.eChem],
      ['Scavenger', o.eFood],
      ['Predator', o.ePrey],
    ];
    parts.sort((a, b) => b[1] - a[1]);
    return parts[0][1] / tot > 0.65 ? parts[0][0] : `Mixotroph (${parts[0][0].toLowerCase()})`;
  }
}
