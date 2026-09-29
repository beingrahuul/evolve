import { Brain } from './brain';
import { A, CT, Genome, MAX_BODY, NALLOC, allocFractions, bodyFractions } from './genome';
import { BIO } from './params';

export const MAXC = MAX_BODY + 1;

export class Organism {
  readonly frac = new Float32Array(NALLOC); // whole-body function fractions
  readonly coreFrac = new Float32Array(NALLOC); // the core cell's own allocation
  brain: Brain;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  heading = 0;

  mass: number;
  energy: number;
  nutrient: number;
  health = 1;
  age = 0;

  // ---- body (unit layout: multiply by `scale` = sqrt(mass) for world units) ----
  nCells = 1; // developed cells
  readonly cx = new Float32Array(MAXC);
  readonly cy = new Float32Array(MAXC);
  readonly cr = new Float32Array(MAXC);
  readonly ctype = new Uint8Array(MAXC);
  readonly share = new Float32Array(MAXC);
  bodyR = BIO.RADIUS_K; // unit bounding radius
  scale = 1;
  /** Cells that can eat (mouth cells, or the core when it has a mouth). */
  readonly mouths = new Int8Array(MAXC);
  nMouths = 0;
  /** Directions of eye cells in the body frame. */
  readonly eyeAngle = new Float32Array(MAXC);
  nEyes = 0;
  // world-space cell centres, refreshed each tick
  readonly wx = new Float32Array(MAXC);
  readonly wy = new Float32Array(MAXC);

  // derived from genome + body
  radius = 1; // bounding radius in world units
  ecap = 1;
  sense = 10;
  upkeepK = 0;
  brainCost = 0;
  resist = 0;

  // current behaviour
  inflate = 0.5;
  thrust = 0;
  turn = 0;
  eating = false;
  glow = 0;
  touching = 0;
  pain = 0;
  digesting = 0; // seconds until it can engulf again
  /** Water content: 1 in the sea; falls on land unless protected or rooted in moist soil. */
  hydration = 1;
  /** True while out of the water (on the beach or inland). */
  onLand = false;
  /** Highest point of the body (world y) — for light competition among land plants. */
  topY = 0;
  dead = false;
  cause = '';

  // lifetime record
  eLight = 0;
  eChem = 0;
  eFood = 0;
  ePrey = 0;
  kills = 0;
  children = 0;
  travelled = 0;

  readonly seed: number;

  constructor(
    readonly id: number,
    public genome: Genome,
    public species: number,
    readonly generation: number,
    readonly parent: number,
    readonly born: number,
    mass: number,
    energy: number,
    nutrient: number,
  ) {
    this.brain = new Brain(genome);
    this.mass = mass;
    this.energy = energy;
    this.nutrient = nutrient;
    this.seed = (id * 0.6180339) % 1;
    this.derive();
  }

  get targetCells(): number {
    return 1 + this.genome.body.length;
  }

  /** Recompute everything that depends on the genome. */
  derive() {
    allocFractions(this.genome, this.coreFrac);
    this.brainCost = BIO.BRAIN_COST * (this.brain.hiddenCount + 0.2 * this.brain.connCount);
    this.nCells = Math.max(1, Math.min(this.targetCells, this.developedFor(this.mass)));
    this.layout();
  }

  /** Replace the genome (god-mode mutation). */
  setGenome(g: Genome) {
    this.genome = g;
    this.brain = new Brain(g);
    this.derive();
  }

  /** How many cells a body of this mass has grown. */
  private developedFor(mass: number): number {
    const n = this.targetCells;
    if (n === 1) return 1;
    const cellMass = this.genome.divMass / n;
    return Math.min(n, 1 + Math.floor(mass / cellMass));
  }

  /** Restore a saved developmental state. */
  setDeveloped(n: number) {
    const k = Math.max(1, Math.min(this.targetCells, n));
    if (k !== this.nCells) {
      this.nCells = k;
      this.layout();
    }
  }

  /** Grow new cells as mass increases; lose them when starving. */
  develop() {
    const n = this.targetCells;
    if (n === 1) return;
    const cellMass = this.genome.divMass / n;
    const up = this.developedFor(this.mass);
    if (up > this.nCells) {
      this.nCells = up;
      this.layout();
    } else if (this.nCells > 1 && this.mass < (this.nCells - 1) * cellMass * 0.6) {
      this.nCells--;
      this.layout();
    }
  }

  /** Place the developed cells: each grows from its parent in its gene's direction. */
  private layout() {
    const g = this.genome;
    const k = this.nCells;
    const { cx, cy, cr, ctype, share } = this;
    let tot = 1;
    for (let i = 1; i < k; i++) tot += g.body[i - 1].size * g.body[i - 1].size;
    const inv = 1 / Math.sqrt(tot);
    cx[0] = 0;
    cy[0] = 0;
    cr[0] = BIO.RADIUS_K * inv;
    ctype[0] = CT.Core;
    share[0] = 1 / tot;
    for (let i = 1; i < k; i++) {
      const c = g.body[i - 1];
      const p = Math.min(i - 1, Math.max(0, c.parent));
      const r = BIO.RADIUS_K * c.size * inv;
      cr[i] = r;
      ctype[i] = c.type;
      share[i] = (c.size * c.size) / tot;
      const ux = Math.cos(c.angle);
      const uy = Math.sin(c.angle);
      const d = (cr[p] + r) * 0.82;
      let x = cx[p] + ux * d;
      let y = cy[p] + uy * d;
      // slide outward until it no longer sits on top of another cell
      for (let it = 0; it < 8; it++) {
        let hit = false;
        for (let j = 0; j < i; j++) {
          if (j === p) continue;
          const ex = x - cx[j];
          const ey = y - cy[j];
          const m = (r + cr[j]) * 0.78;
          if (ex * ex + ey * ey < m * m) {
            hit = true;
            break;
          }
        }
        if (!hit) break;
        x += ux * d * 0.3;
        y += uy * d * 0.3;
      }
      cx[i] = x;
      cy[i] = y;
    }
    // centre of mass at the origin
    let mx = 0;
    let my = 0;
    for (let i = 0; i < k; i++) {
      mx += cx[i] * share[i];
      my += cy[i] * share[i];
    }
    let br = 0;
    this.nMouths = 0;
    this.nEyes = 0;
    for (let i = 0; i < k; i++) {
      cx[i] -= mx;
      cy[i] -= my;
      br = Math.max(br, Math.hypot(cx[i], cy[i]) + cr[i]);
      if (ctype[i] === CT.Mouth) this.mouths[this.nMouths++] = i;
      if (ctype[i] === CT.Eye) this.eyeAngle[this.nEyes++] = Math.atan2(cy[i], cx[i]);
    }
    if (this.coreFrac[A.mouth] > 0.03) this.mouths[this.nMouths++] = 0;
    this.bodyR = br;

    bodyFractions(g, k, this.frac, this.coreFrac);
    let upk = BIO.BASE_METAB;
    for (let i = 0; i < NALLOC; i++) upk += this.frac[i] * BIO.ORGAN_COST[i];
    upk += BIO.MULTI_COST * (k - 1);
    upk *= 1 + 0.008 * g.tempTol + (0.0004 * g.lifespan) / 10 + 0.1 * g.toxinRes;
    this.upkeepK = upk;
    this.resist = Math.min(1, g.toxinRes + this.frac[A.chemo] * 2.5);
    this.updateSize();
  }

  updateSize() {
    this.scale = Math.sqrt(Math.max(0.01, this.mass));
    this.radius = this.bodyR * this.scale;
    this.ecap = this.mass * (1 + 4 * this.frac[A.storage]);
    this.sense = this.radius + BIO.SENSE_BASE + BIO.SENSE_RANGE * this.frac[A.sensor];
  }

  /** World positions of the developed cells (into wx / wy). */
  updateWorldCells() {
    const c = Math.cos(this.heading) * this.scale;
    const s = Math.sin(this.heading) * this.scale;
    for (let i = 0; i < this.nCells; i++) {
      this.wx[i] = this.x + this.cx[i] * c - this.cy[i] * s;
      this.wy[i] = this.y + this.cx[i] * s + this.cy[i] * c;
    }
  }

  /** World radius of cell i. */
  cellR(i: number): number {
    return this.cr[i] * this.scale;
  }
}
