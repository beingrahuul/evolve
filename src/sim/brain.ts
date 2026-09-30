import { Genome, NI, NO } from './genome';

/** Eligibility traces fade with this time constant (seconds): what the brain did recently gets the credit. */
const TRACE_TAU = 1;
/** Learned weights relax back towards the genetic ones with this time constant (seconds). */
const FORGET_TAU = 90;
/** Weight change per second at full reward, learning rate 1 and plasticity 1. */
const LEARN_GAIN = 3;

// ---------------------------------------------------------------------------
// Where a brain lives. Its network is laid out in 32-bit words (read as Int32 or Float32): a header
// of offsets, then the arrays. Brains normally live in slots of a shared arena, so the simulation's
// helper threads can run them (threads.ts); a brain too big for a slot gets a buffer of its own.

const H = {
  N: 0,
  NEVAL: 1,
  NCONN: 2,
  NPLASTIC: 3,
  VALUES: 4,
  EVAL: 5,
  BIAS: 6,
  ACT: 7,
  CSTART: 8,
  CSRC: 9,
  CW: 10,
  CW0: 11,
  CP: 12,
  CE: 13,
  PLK: 14,
  PLPOST: 15,
  SIZE: 16,
} as const;

/** What a slot holds: values (inputs, outputs, hidden), evaluated nodes, synapses. */
const SLOT_VALUES = 72;
const SLOT_EVAL = 32;
const SLOT_CONNS = 96;
const layoutWords = (values: number, evals: number, conns: number) => H.SIZE + values + evals * 3 + (evals + 1) + conns * 7;
export const SLOT_WORDS = layoutWords(SLOT_VALUES, SLOT_EVAL, SLOT_CONNS);

/** Slots for brains in shared memory (or ordinary memory, for a world that is not threaded). */
export class BrainArena {
  readonly f: Float32Array;
  readonly i: Int32Array;
  private free: number[] = [];

  constructor(
    readonly slots: number,
    shared: boolean,
  ) {
    const bytes = slots * SLOT_WORDS * 4;
    const buf = shared ? (new SharedArrayBuffer(bytes) as unknown as ArrayBuffer) : new ArrayBuffer(bytes);
    this.f = new Float32Array(buf);
    this.i = new Int32Array(buf);
    for (let s = slots - 1; s >= 0; s--) this.free.push(s);
  }

  /** A free slot, or -1 when full. */
  alloc(): number {
    return this.free.length ? this.free.pop()! : -1;
  }

  release(slot: number) {
    this.free.push(slot);
  }
}

let arena: BrainArena | null = null;

/** Brains built from now on take slots in this arena (null: each gets a buffer of its own). */
export function useBrainArena(a: BrainArena | null) {
  arena = a;
}

/**
 * A compiled neural network. Nodes are evaluated in genome `order`; a connection from a node that
 * has not been evaluated yet this tick reads its previous value, which gives recurrence (memory)
 * for free.
 *
 * Plastic synapses learn during the organism's life by reward-modulated Hebbian learning: each keeps
 * an eligibility trace of how often its two neurons fired together, and a reward signal (like
 * dopamine) strengthens or weakens the synapses that were recently active. Learned weights are not
 * inherited; they drift back towards the genome's weights when not reinforced.
 */
export class Brain {
  readonly n: number;
  readonly values: Float32Array;
  /** Input slots alias the first NI values so sensors can be written without copying. */
  readonly inputs: Float32Array;
  /** Where the network lives: its buffer (as floats and ints) and the offset of its header. */
  readonly F: Float32Array;
  readonly I: Int32Array;
  readonly base: number;
  /** Its slot in the shared arena, or -1 (a buffer of its own: the simulation thread runs it). */
  slot = -1;
  private arena: BrainArena | null = null;
  /** Current (possibly learned) weights, in evaluation order. */
  readonly cW: Float32Array;
  private cW0: Float32Array;
  private cP: Float32Array;
  private plK: Int32Array;

  // For visualisation
  readonly order: Float32Array;
  readonly nodeActs: Uint8Array;
  readonly edgeSrc: Int32Array;
  readonly edgeDst: Int32Array;
  /** Index of each drawn edge in the weight arrays. */
  private edgeK: Int32Array;
  readonly hiddenCount: number;
  readonly connCount: number;
  readonly plasticCount: number;

  constructor(g: Genome) {
    const hidden = g.nodes.slice(NO);
    this.hiddenCount = hidden.length;
    const n = NI + NO + hidden.length;
    this.n = n;
    this.order = new Float32Array(n);
    this.nodeActs = new Uint8Array(n);

    const indexOf = new Map<number, number>();
    for (let i = 0; i < NI; i++) indexOf.set(i, i);
    const allNodes = g.nodes;
    const nodeBias = new Float32Array(n);
    for (let k = 0; k < allNodes.length; k++) {
      const idx = NI + k;
      indexOf.set(allNodes[k].id, idx);
      this.order[idx] = allNodes[k].order;
      nodeBias[idx] = allNodes[k].bias;
      this.nodeActs[idx] = allNodes[k].act;
    }

    const incoming: { src: number; w: number; p: number; edge: number }[][] = [];
    for (let i = 0; i < n; i++) incoming.push([]);
    const es: number[] = [];
    const ed: number[] = [];
    for (const c of g.conns) {
      if (!c.on) continue;
      const s = indexOf.get(c.from);
      const d = indexOf.get(c.to);
      if (s === undefined || d === undefined || d < NI) continue;
      incoming[d].push({ src: s, w: c.w, p: c.p ?? 0, edge: es.length });
      es.push(s);
      ed.push(d);
    }
    this.edgeSrc = Int32Array.from(es);
    this.edgeDst = Int32Array.from(ed);
    this.edgeK = new Int32Array(es.length);
    const nConn = es.length;
    this.connCount = nConn;

    const evalNodes: number[] = [];
    for (let i = NI; i < n; i++) evalNodes.push(i);
    evalNodes.sort((a, b) => this.order[a] - this.order[b] || a - b);
    const nEval = evalNodes.length;

    // a slot in the arena if it fits, else a buffer sized for it
    let words: number;
    let vCap = SLOT_VALUES;
    let eCap = SLOT_EVAL;
    let cCap = SLOT_CONNS;
    if (arena && n <= SLOT_VALUES && nEval <= SLOT_EVAL && nConn <= SLOT_CONNS && (this.slot = arena.alloc()) >= 0) {
      this.arena = arena;
      this.F = arena.f;
      this.I = arena.i;
      this.base = this.slot * SLOT_WORDS;
      words = SLOT_WORDS;
    } else {
      this.slot = -1;
      vCap = n;
      eCap = nEval;
      cCap = nConn;
      words = layoutWords(vCap, eCap, cCap);
      const buf = new ArrayBuffer(words * 4);
      this.F = new Float32Array(buf);
      this.I = new Int32Array(buf);
      this.base = 0;
    }
    const { F, I, base } = this;
    F.fill(0, base, base + words);
    // header: absolute offsets of each array
    let at = base + H.SIZE;
    const place = (h: number, len: number) => {
      I[base + h] = at;
      at += len;
    };
    I[base + H.N] = n;
    I[base + H.NEVAL] = nEval;
    I[base + H.NCONN] = nConn;
    place(H.VALUES, vCap);
    place(H.EVAL, eCap);
    place(H.BIAS, eCap);
    place(H.ACT, eCap);
    place(H.CSTART, eCap + 1);
    place(H.CSRC, cCap);
    place(H.CW, cCap);
    place(H.CW0, cCap);
    place(H.CP, cCap);
    place(H.CE, cCap);
    place(H.PLK, cCap);
    place(H.PLPOST, cCap);

    const oEval = I[base + H.EVAL];
    const oBias = I[base + H.BIAS];
    const oAct = I[base + H.ACT];
    const oStart = I[base + H.CSTART];
    const oSrc = I[base + H.CSRC];
    const oW = I[base + H.CW];
    const oW0 = I[base + H.CW0];
    const oP = I[base + H.CP];
    const oPlK = I[base + H.PLK];
    const oPlPost = I[base + H.PLPOST];
    let k = 0;
    let np = 0;
    evalNodes.forEach((node, e) => {
      I[oEval + e] = node;
      F[oBias + e] = nodeBias[node];
      I[oAct + e] = this.nodeActs[node];
      I[oStart + e] = k;
      for (const inc of incoming[node]) {
        I[oSrc + k] = inc.src;
        F[oW + k] = inc.w;
        F[oW0 + k] = inc.w;
        F[oP + k] = inc.p;
        this.edgeK[inc.edge] = k;
        if (inc.p !== 0) {
          I[oPlK + np] = k;
          I[oPlPost + np] = node;
          np++;
        }
        k++;
      }
    });
    I[oStart + nEval] = k;
    I[base + H.NPLASTIC] = np;
    this.plasticCount = np;

    const oV = I[base + H.VALUES];
    this.values = F.subarray(oV, oV + n);
    this.inputs = this.values.subarray(0, NI);
    this.cW = F.subarray(oW, oW + nConn);
    this.cW0 = F.subarray(oW0, oW0 + nConn);
    this.cP = F.subarray(oP, oP + nConn);
    this.plK = I.subarray(oPlK, oPlK + np);
  }

  /** Give its arena slot back (the organism died, or has a new genome). */
  release() {
    if (this.arena && this.slot >= 0) this.arena.release(this.slot);
    this.slot = -1;
    this.arena = null;
  }

  step(): void {
    stepBrain(this.F, this.I, this.base);
  }

  /**
   * One step of learning: `reward` in [-1, 1] (better or worse than expected), `rate` the genome's
   * learning rate (times the law of nature), `dt` in seconds.
   */
  learn(reward: number, rate: number, dt: number): void {
    learnBrain(this.F, this.I, this.base, reward, rate, dt);
  }

  output(k: number): number {
    const y = this.values[NI + k];
    return y > 1 ? 1 : y < -1 ? -1 : y;
  }

  /** Current weight of drawn edge e. */
  edgeWeight(e: number): number {
    return this.cW[this.edgeK[e]];
  }

  /** How much edge e has learned: current minus genetic weight (0 for hard-wired synapses). */
  edgeLearned(e: number): number {
    const k = this.edgeK[e];
    return this.cW[k] - this.cW0[k];
  }

  isPlastic(e: number): boolean {
    return this.cP[this.edgeK[e]] !== 0;
  }

  /** Mean absolute change of the plastic weights from the genome's values. */
  learnedDrift(): number {
    const n = this.plK.length;
    if (!n) return 0;
    let s = 0;
    for (let q = 0; q < n; q++) {
      const k = this.plK[q];
      s += Math.abs(this.cW[k] - this.cW0[k]);
    }
    return s / n;
  }

  /** Restore learned weights (a save file, or the simulation thread's copy). */
  setWeights(w: ArrayLike<number>) {
    if (w.length === this.cW.length) this.cW.set(w);
  }
}

/** Where the values (inputs first) of the network whose header is at `base` start. */
export function valuesAt(I: Int32Array, base: number): number {
  return I[base + H.VALUES];
}

/** Evaluate the network whose header is at `base` (any thread can run any brain it can see). */
export function stepBrain(F: Float32Array, I: Int32Array, base: number) {
  const nEval = I[base + H.NEVAL];
  const oV = I[base + H.VALUES];
  const oEval = I[base + H.EVAL];
  const oBias = I[base + H.BIAS];
  const oAct = I[base + H.ACT];
  const oStart = I[base + H.CSTART];
  const oSrc = I[base + H.CSRC];
  const oW = I[base + H.CW];
  for (let e = 0; e < nEval; e++) {
    let s = F[oBias + e];
    const k1 = I[oStart + e + 1];
    for (let k = I[oStart + e]; k < k1; k++) s += F[oW + k] * F[oV + I[oSrc + k]];
    let y: number;
    switch (I[oAct + e]) {
      case 0:
        y = Math.tanh(s);
        break;
      case 1:
        y = 1 / (1 + Math.exp(-s));
        break;
      case 2:
        y = s > 0 ? (s < 4 ? s : 4) : 0;
        break;
      case 3:
        y = Math.sin(s);
        break;
      case 4:
        y = Math.exp(-s * s);
        break;
      default:
        y = s > 4 ? 4 : s < -4 ? -4 : s;
    }
    F[oV + I[oEval + e]] = y;
  }
}

/** Reward-modulated Hebbian learning for the network whose header is at `base`. */
export function learnBrain(F: Float32Array, I: Int32Array, base: number, reward: number, rate: number, dt: number) {
  const n = I[base + H.NPLASTIC];
  if (n === 0) return;
  const oV = I[base + H.VALUES];
  const oSrc = I[base + H.CSRC];
  const oW = I[base + H.CW];
  const oW0 = I[base + H.CW0];
  const oP = I[base + H.CP];
  const oE = I[base + H.CE];
  const oPlK = I[base + H.PLK];
  const oPlPost = I[base + H.PLPOST];
  const fade = Math.min(1, dt / TRACE_TAU);
  const forget = Math.min(1, dt / FORGET_TAU);
  const gain = rate * reward * LEARN_GAIN * dt;
  for (let q = 0; q < n; q++) {
    const k = I[oPlK + q];
    let pre = F[oV + I[oSrc + k]];
    let post = F[oV + I[oPlPost + q]];
    pre = pre > 1 ? 1 : pre < -1 ? -1 : pre;
    post = post > 1 ? 1 : post < -1 ? -1 : post;
    const e = F[oE + k] + (pre * post - F[oE + k]) * fade;
    F[oE + k] = e;
    const w = F[oW + k] + gain * F[oP + k] * e + (F[oW0 + k] - F[oW + k]) * forget;
    F[oW + k] = w > 6 ? 6 : w < -6 ? -6 : w;
  }
}
