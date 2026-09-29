import { Rng, clamp } from './rng';

// ---------------------------------------------------------------------------
// Sensors (brain inputs) and actions (brain outputs)
// ---------------------------------------------------------------------------

export const INPUT_NAMES = [
  'bias',
  'energy',
  'health',
  'size',
  'clock',
  'touch',
  'light',
  'up · fwd',
  'up · side',
  'depth',
  'temp Δ',
  'oxygen',
  'sulfide',
  'nutrients',
  'food · fwd',
  'food · side',
  'cell · fwd',
  'cell · side',
  'cell size',
  'cell kin',
  'cell threat',
  'cell glow',
  'pain',
  'kin · fwd',
  'kin · side',
  'cell green',
  'light ∇',
  'nutrient ∇',
  'sulfide ∇',
  'in water',
  'hydration',
  'rain',
] as const;

export const OUTPUT_NAMES = ['thrust', 'turn', 'eat', 'float', 'glow'] as const;

export const NI = INPUT_NAMES.length;
export const NO = OUTPUT_NAMES.length;

export const IN = {
  Bias: 0,
  Energy: 1,
  Health: 2,
  Size: 3,
  Clock: 4,
  Touch: 5,
  Light: 6,
  UpFwd: 7,
  UpSide: 8,
  Depth: 9,
  TempDev: 10,
  Oxygen: 11,
  Sulfide: 12,
  Nutrients: 13,
  FoodFwd: 14,
  FoodSide: 15,
  CellFwd: 16,
  CellSide: 17,
  CellSize: 18,
  CellKin: 19,
  CellThreat: 20,
  CellGlow: 21,
  Pain: 22,
  KinFwd: 23,
  KinSide: 24,
  CellGreen: 25,
  LightGrad: 26,
  NutGrad: 27,
  SulfGrad: 28,
  InWater: 29,
  Hydration: 30,
  Rain: 31,
} as const;

export const OUT = { Thrust: 0, Turn: 1, Eat: 2, Float: 3, Glow: 4 } as const;

// ---------------------------------------------------------------------------
// Cell-volume allocation: what fraction of the cell is devoted to each organelle
// ---------------------------------------------------------------------------

export const A = {
  chloro: 0,
  chemo: 1,
  mouth: 2,
  flagella: 3,
  armor: 4,
  sensor: 5,
  vacuole: 6,
  storage: 7,
  root: 8,
} as const;

export const ALLOC_NAMES = [
  'Chloroplasts',
  'Chemosynthesis',
  'Mouth',
  'Flagella',
  'Armor',
  'Senses',
  'Gas vacuole',
  'Storage',
  'Roots & cuticle',
] as const;

export const ALLOC_COLORS = [
  '#4ade80',
  '#fb923c',
  '#f87171',
  '#a5b4fc',
  '#a8a29e',
  '#f472b6',
  '#7dd3fc',
  '#fde68a',
  '#c08a57',
] as const;

export const NALLOC = 9;
/** Share of the cell that is plain cytoplasm; keeps fractions below 1. */
const CYTOPLASM = 0.6;

export const ACT_NAMES = ['tanh', 'sigmoid', 'relu', 'sin', 'gauss', 'linear'] as const;

// ---------------------------------------------------------------------------
// Multicellular body plan. Cell 0 is the core (a generalist with the alloc genes);
// every other cell is a specialist devoted to one function (type t ↔ alloc index t-1).
// ---------------------------------------------------------------------------

export const CT = {
  Core: 0,
  Photo: 1,
  Chemo: 2,
  Mouth: 3,
  Motor: 4,
  Armor: 5,
  Eye: 6,
  Float: 7,
  Storage: 8,
  Root: 9,
} as const;

export const CELL_TYPE_NAMES = [
  'Core cell',
  'Photocyte',
  'Chemocyte',
  'Mouth cell',
  'Motor cell',
  'Shell cell',
  'Eye cell',
  'Float cell',
  'Fat cell',
  'Root cell',
] as const;

export const CELL_TYPE_COLORS = ['#c4b5fd', ...ALLOC_COLORS] as const;

/** Maximum specialist cells on top of the core. */
export const MAX_BODY = 11;
/** Fraction of a specialist cell devoted to its function (a generalist gets at most ~0.6). */
export const SPECIALIST = 0.85;

export interface CellGene {
  parent: number; // index in [core, ...body] of the cell it grows from (always earlier)
  angle: number; // direction from the parent, radians in the body frame (0 = forward)
  type: number; // CT.*
  size: number; // relative radius
}

export interface NodeGene {
  id: number;
  /** Evaluation order in (0, 1] — inputs are 0, outputs are 1, hidden nodes sit in between. */
  order: number;
  bias: number;
  act: number;
}

export interface ConnGene {
  from: number;
  to: number;
  w: number;
  on: boolean;
}

export interface Genome {
  alloc: number[]; // raw organelle investment, 0..1 each
  divMass: number; // divide when body mass reaches this
  tempOpt: number; // °C
  tempTol: number; // °C
  lifespan: number; // seconds
  hue: number; // membrane pigment
  sig: number[]; // chemical signature: drifts neutrally, used for kin recognition
  mutRate: number;
  oscFreq: number; // internal clock (Hz)
  toxinRes: number;
  nodes: NodeGene[]; // outputs first (ids NI..NI+NO-1), then hidden
  conns: ConnGene[];
  nextId: number;
  body: CellGene[]; // extra cells, in the order they develop
}

export function allocFractions(g: Genome, out: Float32Array | number[]): void {
  let sum = CYTOPLASM;
  for (let i = 0; i < NALLOC; i++) sum += g.alloc[i];
  for (let i = 0; i < NALLOC; i++) out[i] = g.alloc[i] / sum;
}

/**
 * Function fractions of a body with its first `k` cells developed:
 * each cell contributes its volume share (size²) to its function.
 */
export function bodyFractions(g: Genome, k: number, out: Float32Array | number[], core?: ArrayLike<number>): void {
  let tot = 1;
  const n = Math.min(k - 1, g.body.length);
  for (let i = 0; i < n; i++) tot += g.body[i].size * g.body[i].size;
  if (!core) {
    allocFractions(g, out);
    core = Array.from(out as ArrayLike<number>);
  }
  const s0 = 1 / tot;
  for (let j = 0; j < NALLOC; j++) out[j] = core[j] * s0;
  for (let i = 0; i < n; i++) {
    const c = g.body[i];
    out[c.type - 1] += ((c.size * c.size) / tot) * SPECIALIST;
  }
}

/** Fractions of the fully developed body. */
export function effectiveFractions(g: Genome, out: Float32Array | number[]): void {
  bodyFractions(g, g.body.length + 1, out);
}

export function cloneGenome(g: Genome): Genome {
  return {
    alloc: g.alloc.slice(),
    divMass: g.divMass,
    tempOpt: g.tempOpt,
    tempTol: g.tempTol,
    lifespan: g.lifespan,
    hue: g.hue,
    sig: g.sig.slice(),
    mutRate: g.mutRate,
    oscFreq: g.oscFreq,
    toxinRes: g.toxinRes,
    nodes: g.nodes.map((n) => ({ ...n })),
    conns: g.conns.map((c) => ({ ...c })),
    nextId: g.nextId,
    body: g.body.map((c) => ({ ...c })),
  };
}

// ---------------------------------------------------------------------------
// Seed archetypes — starting points; evolution takes it from there.
// ---------------------------------------------------------------------------

export type Archetype =
  | 'photo'
  | 'chemo'
  | 'grazer'
  | 'hunter'
  | 'scavenger'
  | 'colony'
  | 'stalker'
  | 'pioneer'
  | 'plant'
  | 'random';

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  photo: 'Phototroph (eats light)',
  chemo: 'Chemotroph (vent dweller)',
  grazer: 'Grazer (eats small cells)',
  hunter: 'Hunter (predator)',
  scavenger: 'Scavenger (eats detritus)',
  colony: 'Algal colony (multicellular)',
  stalker: 'Stalker (multicellular predator)',
  pioneer: 'Intertidal pioneer (tolerates drying)',
  plant: 'Land plant (roots, stem, leaves)',
  random: 'Random protocell',
};

type Wire = [from: number, out: number, w: number];

type BodyCell = [parent: number, angleDeg: number, type: number, size: number];

interface Preset {
  alloc: number[];
  div: number;
  temp: number;
  tol: number;
  hue: number;
  wires: Wire[];
  body?: BodyCell[];
}

const O = (k: number) => NI + k;

const SIG_BASE: Record<Exclude<Archetype, 'random'>, number[]> = {
  photo: [0.2, 0.8, 0.3],
  chemo: [0.8, 0.2, 0.3],
  grazer: [0.3, 0.3, 0.8],
  hunter: [0.8, 0.8, 0.8],
  scavenger: [0.5, 0.2, 0.9],
  pioneer: [0.15, 0.6, 0.6],
  plant: [0.1, 0.55, 0.15],
  colony: [0.1, 0.9, 0.5],
  stalker: [0.9, 0.5, 0.1],
};

const PRESETS: Record<Exclude<Archetype, 'random'>, Preset> = {
  photo: {
    alloc: [0.9, 0.02, 0.02, 0.15, 0.05, 0.05, 0.45, 0.2, 0.01],
    div: 6,
    temp: 20,
    tol: 12,
    hue: 0.3,
    wires: [
      [IN.Bias, O(OUT.Thrust), 0.2],
      [IN.Depth, O(OUT.Float), 2.5],
      [IN.Light, O(OUT.Float), -1.2],
      [IN.Bias, O(OUT.Float), 0.2],
      [IN.Touch, O(OUT.Turn), 1.5],
    ],
  },
  chemo: {
    alloc: [0.02, 0.9, 0.03, 0.2, 0.2, 0.1, 0.02, 0.3, 0.01],
    div: 8,
    temp: 28,
    tol: 20,
    hue: 0.08,
    wires: [
      [IN.Bias, O(OUT.Float), -2.0],
      [IN.Bias, O(OUT.Thrust), 0.5],
      [IN.Sulfide, O(OUT.Thrust), -2.0],
      [IN.Clock, O(OUT.Turn), 1.0],
    ],
  },
  grazer: {
    alloc: [0.08, 0.02, 0.6, 0.45, 0.05, 0.5, 0.3, 0.2, 0.01],
    div: 12,
    temp: 18,
    tol: 12,
    hue: 0.55,
    wires: [
      [IN.CellSide, O(OUT.Turn), 2.5],
      [IN.CellFwd, O(OUT.Thrust), 1.2],
      [IN.Bias, O(OUT.Thrust), 0.25],
      [IN.Bias, O(OUT.Eat), 1.0],
      [IN.CellKin, O(OUT.Eat), -2.5],
      [IN.Depth, O(OUT.Float), 3.0],
      [IN.Bias, O(OUT.Float), 0.4],
      [IN.Clock, O(OUT.Turn), 0.5],
    ],
  },
  hunter: {
    alloc: [0.02, 0.02, 0.85, 0.65, 0.12, 0.5, 0.15, 0.3, 0.01],
    div: 13,
    temp: 16,
    tol: 12,
    hue: 0.95,
    wires: [
      [IN.CellSide, O(OUT.Turn), 3.0],
      [IN.CellFwd, O(OUT.Thrust), 1.5],
      [IN.CellSize, O(OUT.Thrust), -1.0],
      [IN.Bias, O(OUT.Thrust), 0.3],
      [IN.Bias, O(OUT.Eat), 1.0],
      [IN.CellKin, O(OUT.Eat), -2.5],
      [IN.Depth, O(OUT.Float), 2.0],
      [IN.Clock, O(OUT.Turn), 0.6],
    ],
  },
  scavenger: {
    alloc: [0.02, 0.05, 0.6, 0.35, 0.1, 0.4, 0.02, 0.3, 0.01],
    div: 8,
    temp: 10,
    tol: 12,
    hue: 0.12,
    wires: [
      [IN.FoodSide, O(OUT.Turn), 3.0],
      [IN.FoodFwd, O(OUT.Thrust), 1.5],
      [IN.Bias, O(OUT.Thrust), 0.2],
      [IN.Bias, O(OUT.Eat), 1.0],
      [IN.CellKin, O(OUT.Eat), -2.5],
      [IN.Bias, O(OUT.Float), -1.2],
      [IN.Clock, O(OUT.Turn), 0.8],
    ],
  },
  // Volvox-like: a rosette of photocytes around a core, kept afloat by a float cell
  colony: {
    alloc: [0.6, 0.02, 0.02, 0.2, 0.05, 0.1, 0.3, 0.3, 0.01],
    div: 20,
    temp: 19,
    tol: 12,
    hue: 0.36,
    wires: [
      [IN.Bias, O(OUT.Thrust), 0.25],
      [IN.Depth, O(OUT.Float), 2.5],
      [IN.Light, O(OUT.Float), -1.1],
      [IN.Bias, O(OUT.Float), 0.3],
      [IN.LightGrad, O(OUT.Turn), 1.2],
      [IN.Touch, O(OUT.Turn), 1.2],
    ],
    body: [
      [0, 0, CT.Photo, 0.85],
      [0, 72, CT.Photo, 0.85],
      [0, 144, CT.Float, 0.75],
      [0, 216, CT.Photo, 0.85],
      [0, 288, CT.Photo, 0.85],
      [0, 180, CT.Motor, 0.6],
    ],
  },
  // a hunter with a mouth at the front, two forward eyes, a shell and a motor tail
  stalker: {
    alloc: [0.02, 0.02, 0.45, 0.3, 0.1, 0.3, 0.2, 0.4, 0.01],
    div: 30,
    temp: 16,
    tol: 12,
    hue: 0.98,
    wires: [
      [IN.CellSide, O(OUT.Turn), 3.0],
      [IN.CellFwd, O(OUT.Thrust), 1.5],
      [IN.CellGreen, O(OUT.Thrust), 0.6],
      [IN.Bias, O(OUT.Thrust), 0.3],
      [IN.Bias, O(OUT.Eat), 1.0],
      [IN.CellKin, O(OUT.Eat), -2.5],
      [IN.Depth, O(OUT.Float), 2.2],
      [IN.Clock, O(OUT.Turn), 0.5],
    ],
    body: [
      [0, 0, CT.Mouth, 1.0],
      [1, -55, CT.Eye, 0.55],
      [1, 55, CT.Eye, 0.55],
      [0, 180, CT.Motor, 0.8],
      [4, 180, CT.Motor, 0.65],
      [0, 90, CT.Armor, 0.7],
      [0, 270, CT.Armor, 0.7],
    ],
  },
  // a tough, waxy alga of the tide pools: photosynthesises in water and survives being stranded
  pioneer: {
    alloc: [0.75, 0.02, 0.02, 0.12, 0.15, 0.05, 0.2, 0.35, 0.55],
    div: 7,
    temp: 18,
    tol: 15,
    hue: 0.22,
    wires: [
      [IN.Bias, O(OUT.Thrust), 0.15],
      [IN.Depth, O(OUT.Float), 1.5],
      [IN.Light, O(OUT.Float), -0.8],
      [IN.LightGrad, O(OUT.Turn), 1.0],
      [IN.InWater, O(OUT.Thrust), 0.4],
    ],
  },
  // roots below, a woody stem, leaves above; on land it grows towards the light
  plant: {
    alloc: [0.45, 0.02, 0.02, 0.02, 0.2, 0.05, 0.02, 0.35, 0.5],
    div: 22,
    temp: 16,
    tol: 16,
    hue: 0.28,
    wires: [[IN.Bias, O(OUT.Thrust), -1]],
    body: [
      [0, 180, CT.Root, 0.8],
      [1, 180, CT.Root, 0.6],
      [0, 0, CT.Armor, 0.65],
      [3, -35, CT.Photo, 0.85],
      [3, 35, CT.Photo, 0.85],
      [3, 0, CT.Photo, 0.8],
    ],
  },
};

function baseGenome(rng: Rng): Genome {
  const nodes: NodeGene[] = [];
  for (let k = 0; k < NO; k++) nodes.push({ id: NI + k, order: 1, bias: 0, act: 0 });
  return {
    alloc: new Array(NALLOC).fill(0),
    divMass: 8,
    tempOpt: 18,
    tempTol: 12,
    lifespan: rng.range(160, 240),
    hue: rng.next(),
    sig: [rng.next(), rng.next(), rng.next()],
    mutRate: 1,
    oscFreq: rng.range(0.2, 1.2),
    toxinRes: 0.05,
    nodes,
    conns: [],
    nextId: NI + NO,
    body: [],
  };
}

export function makeGenome(rng: Rng, arch: Archetype): Genome {
  const g = baseGenome(rng);
  if (arch === 'random') {
    for (let i = 0; i < NALLOC; i++) g.alloc[i] = rng.next() ** 2;
    g.divMass = rng.range(4, 14);
    g.tempOpt = rng.range(8, 30);
    const n = 3 + rng.int(5);
    for (let i = 0; i < n; i++) {
      g.conns.push({ from: rng.int(NI), to: NI + rng.int(NO), w: rng.gauss() * 1.5, on: true });
    }
    // always give a way to eat if it has a mouth
    g.conns.push({ from: 0, to: NI + OUT.Eat, w: 1, on: true });
    return g;
  }
  const p = PRESETS[arch];
  for (let i = 0; i < NALLOC; i++) g.alloc[i] = clamp(p.alloc[i] + rng.gauss() * 0.04, 0, 1);
  g.divMass = p.div * Math.exp(rng.gauss() * 0.1);
  g.tempOpt = p.temp + rng.gauss() * 2;
  g.tempTol = p.tol;
  g.hue = (p.hue + rng.gauss() * 0.03 + 1) % 1;
  // members of one seeded lineage share a chemical signature
  const base = SIG_BASE[arch];
  g.sig = base.map((v) => clamp(v + rng.gauss() * 0.02, 0, 1));
  for (const [from, to, w] of p.wires) g.conns.push({ from, to, w: w + rng.gauss() * 0.15, on: true });
  if (p.body) {
    g.body = p.body.map(([parent, deg, type, size]) => ({
      parent,
      angle: (deg * Math.PI) / 180 + rng.gauss() * 0.05,
      type,
      size: size * Math.exp(rng.gauss() * 0.05),
    }));
  }
  return g;
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

const MAX_HIDDEN = 24;
const MAX_CONNS = 90;

/** Probability p per unit mutation, scaled to mutation strength m. */
const pm = (p: number, m: number) => 1 - Math.pow(1 - p, m);

export function mutate(parent: Genome, rng: Rng, globalRate: number): Genome {
  const g = cloneGenome(parent);
  const m = globalRate * g.mutRate;
  // neutral drift: pigment and chemical signature always drift a little (lineage marker)
  g.hue = (g.hue + rng.gauss() * 0.008 + 1) % 1;
  for (let i = 0; i < 3; i++) g.sig[i] = clamp(g.sig[i] + rng.gauss() * 0.015, 0, 1);
  if (m <= 0) return g;

  for (let i = 0; i < NALLOC; i++) {
    if (rng.chance(pm(0.22, m))) g.alloc[i] = clamp(g.alloc[i] + rng.gauss() * 0.07, 0, 1);
    if (rng.chance(pm(0.006, m))) g.alloc[i] = rng.next() ** 2;
  }
  if (rng.chance(pm(0.2, m))) g.divMass = clamp(g.divMass * Math.exp(rng.gauss() * 0.1), 2.5, 45);
  if (rng.chance(pm(0.2, m))) g.tempOpt = clamp(g.tempOpt + rng.gauss() * 2, 0, 95);
  if (rng.chance(pm(0.12, m))) g.tempTol = clamp(g.tempTol + rng.gauss(), 3, 30);
  if (rng.chance(pm(0.12, m))) g.lifespan = clamp(g.lifespan * Math.exp(rng.gauss() * 0.1), 30, 900);
  if (rng.chance(pm(0.08, m))) g.mutRate = clamp(g.mutRate * Math.exp(rng.gauss() * 0.15), 0.2, 3);
  if (rng.chance(pm(0.1, m))) g.oscFreq = clamp(g.oscFreq * Math.exp(rng.gauss() * 0.2), 0.02, 4);
  if (rng.chance(pm(0.1, m))) g.toxinRes = clamp(g.toxinRes + rng.gauss() * 0.05, 0, 1);

  mutateBody(g, rng, m);

  // --- brain ---
  for (const c of g.conns) {
    if (rng.chance(pm(0.18, m))) c.w = clamp(c.w + rng.gauss() * 0.4, -6, 6);
    if (rng.chance(pm(0.015, m))) c.w = rng.gauss() * 1.5;
    if (rng.chance(pm(0.01, m))) c.on = !c.on;
  }
  for (const nd of g.nodes) {
    if (rng.chance(pm(0.08, m))) nd.bias = clamp(nd.bias + rng.gauss() * 0.3, -4, 4);
    if (nd.id >= NI + NO && rng.chance(pm(0.02, m))) nd.act = rng.int(ACT_NAMES.length);
  }
  const hidden = g.nodes.length - NO;
  // add a connection
  if (g.conns.length < MAX_CONNS && rng.chance(pm(0.1, m))) {
    const srcPool = NI + hidden;
    const s = rng.int(srcPool);
    const from = s < NI ? s : g.nodes[NO + (s - NI)].id;
    const to = g.nodes[rng.int(g.nodes.length)].id;
    if (!g.conns.some((c) => c.from === from && c.to === to)) {
      g.conns.push({ from, to, w: rng.gauss() * 1.2, on: true });
    }
  }
  // add a node by splitting a connection (NEAT style)
  if (hidden < MAX_HIDDEN && g.conns.length > 0 && rng.chance(pm(0.035, m))) {
    const c = g.conns[rng.int(g.conns.length)];
    if (c.on) {
      const fromOrder = c.from < NI ? 0 : orderOf(g, c.from);
      const toOrder = orderOf(g, c.to);
      let order = (fromOrder + toOrder) / 2;
      if (toOrder <= fromOrder) order = clamp(fromOrder + rng.range(-0.1, 0.1), 0.05, 0.95);
      order = clamp(order + rng.gauss() * 0.02, 0.02, 0.98);
      const id = g.nextId++;
      g.nodes.push({ id, order, bias: 0, act: 0 });
      c.on = false;
      g.conns.push({ from: c.from, to: id, w: 1, on: true });
      g.conns.push({ from: id, to: c.to, w: c.w, on: true });
    }
  }
  // remove a connection
  if (g.conns.length > 0 && rng.chance(pm(0.03, m))) g.conns.splice(rng.int(g.conns.length), 1);
  // drop disabled connections occasionally and prune orphan hidden nodes
  if (rng.chance(0.1)) g.conns = g.conns.filter((c) => c.on || rng.chance(0.5));
  if (hidden > 0 && rng.chance(0.1)) pruneOrphans(g);
  return g;
}

/** Body-plan mutations: grow a new cell, lose one, respecialise, reshape. */
function mutateBody(g: Genome, rng: Rng, m: number) {
  const body = g.body;
  for (const c of body) {
    if (rng.chance(pm(0.1, m))) c.angle += rng.gauss() * 0.3;
    if (rng.chance(pm(0.08, m))) c.size = clamp(c.size * Math.exp(rng.gauss() * 0.12), 0.45, 1.5);
    if (rng.chance(pm(0.02, m))) c.type = 1 + rng.int(9);
  }
  if (body.length < MAX_BODY && rng.chance(pm(0.03, m))) {
    if (body.length > 0 && rng.chance(0.35)) {
      // bilateral symmetry: mirror an existing cell
      const src = body[rng.int(body.length)];
      body.push({ parent: src.parent, angle: -src.angle, type: src.type, size: src.size });
    } else {
      body.push({
        parent: rng.int(body.length + 1),
        angle: rng.range(-Math.PI, Math.PI),
        type: 1 + rng.int(9),
        size: rng.range(0.55, 1.1),
      });
    }
  }
  if (body.length > 0 && rng.chance(pm(0.02, m))) {
    // remove a leaf cell (one nothing else grows from) and re-index parents
    const used = new Set(body.map((c) => c.parent));
    const leaves: number[] = [];
    for (let i = 0; i < body.length; i++) if (!used.has(i + 1)) leaves.push(i);
    if (leaves.length) {
      const k = leaves[rng.int(leaves.length)];
      body.splice(k, 1);
      for (const c of body) if (c.parent > k + 1) c.parent--;
    }
  }
}

function orderOf(g: Genome, id: number): number {
  if (id < NI) return 0;
  const n = g.nodes.find((x) => x.id === id);
  return n ? n.order : 1;
}

function pruneOrphans(g: Genome) {
  const used = new Set<number>();
  for (const c of g.conns) {
    used.add(c.from);
    used.add(c.to);
  }
  g.nodes = g.nodes.filter((n) => n.id < NI + NO || used.has(n.id));
}

// ---------------------------------------------------------------------------
// Genetic distance (used for species clustering)
// ---------------------------------------------------------------------------

const fa = new Float32Array(NALLOC);
const fb = new Float32Array(NALLOC);

export function genomeDistance(a: Genome, b: Genome): number {
  effectiveFractions(a, fa);
  effectiveFractions(b, fb);
  let d = 0;
  for (let i = 0; i < NALLOC; i++) d += Math.abs(fa[i] - fb[i]) * 1.4;
  d += Math.abs(Math.log(a.divMass / b.divMass)) * 0.5;
  d += Math.abs(a.tempOpt - b.tempOpt) / 30;
  const s0 = a.sig[0] - b.sig[0];
  const s1 = a.sig[1] - b.sig[1];
  const s2 = a.sig[2] - b.sig[2];
  d += Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2) * 1.2;
  d += Math.abs(a.nodes.length - b.nodes.length) * 0.04;
  d += Math.abs(a.body.length - b.body.length) * 0.12;
  return d;
}

export function signatureKin(a: Genome, b: Genome): number {
  const s0 = a.sig[0] - b.sig[0];
  const s1 = a.sig[1] - b.sig[1];
  const s2 = a.sig[2] - b.sig[2];
  const d = Math.sqrt(s0 * s0 + s1 * s1 + s2 * s2);
  return 1 - Math.min(1, d / 0.25);
}

/** Dominant lifestyle implied by the organelles. */
export function genomeRole(frac: ArrayLike<number>): string {
  const photo = frac[A.chloro];
  const chemo = frac[A.chemo];
  const mouth = frac[A.mouth];
  const max = Math.max(photo, chemo, mouth);
  if (max < 0.08) return 'Protocell';
  if (frac[A.root] > 0.14) return max === photo ? 'Land plant' : max === mouth ? 'Land forager' : 'Land dweller';
  if (max === photo) return mouth > photo * 0.6 ? 'Mixotroph' : 'Phototroph';
  if (max === chemo) return 'Chemotroph';
  return 'Heterotroph';
}
