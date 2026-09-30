import { Genome, NI, NO } from './genome';

/** Eligibility traces fade with this time constant (seconds): what the brain did recently gets the credit. */
const TRACE_TAU = 1;
/** Learned weights relax back towards the genetic ones with this time constant (seconds). */
const FORGET_TAU = 90;
/** Weight change per second at full reward, learning rate 1 and plasticity 1. */
const LEARN_GAIN = 3;

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

  private evalIdx: Int32Array;
  private bias: Float32Array;
  private act: Uint8Array;
  private cStart: Int32Array;
  private cSrc: Int32Array;
  /** Current (possibly learned) weights, in evaluation order. */
  readonly cW: Float32Array;
  /** Weights as the genome wrote them. */
  private cW0: Float32Array;
  private cP: Float32Array;
  private cE: Float32Array;
  /** Plastic synapses: index into the weight arrays, and the neuron each one feeds. */
  private plK: Int32Array;
  private plPost: Int32Array;

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
    this.n = NI + NO + hidden.length;
    this.values = new Float32Array(this.n);
    this.inputs = this.values.subarray(0, NI);
    this.order = new Float32Array(this.n);
    this.nodeActs = new Uint8Array(this.n);

    const indexOf = new Map<number, number>();
    for (let i = 0; i < NI; i++) indexOf.set(i, i);
    const allNodes = g.nodes;
    const nodeBias = new Float32Array(this.n);
    for (let k = 0; k < allNodes.length; k++) {
      const idx = NI + k;
      indexOf.set(allNodes[k].id, idx);
      this.order[idx] = allNodes[k].order;
      nodeBias[idx] = allNodes[k].bias;
      this.nodeActs[idx] = allNodes[k].act;
    }

    const incoming: { src: number; w: number; p: number; edge: number }[][] = [];
    for (let i = 0; i < this.n; i++) incoming.push([]);
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
    this.connCount = es.length;

    const evalNodes: number[] = [];
    for (let i = NI; i < this.n; i++) evalNodes.push(i);
    evalNodes.sort((a, b) => this.order[a] - this.order[b] || a - b);

    this.evalIdx = Int32Array.from(evalNodes);
    this.bias = new Float32Array(evalNodes.length);
    this.act = new Uint8Array(evalNodes.length);
    this.cStart = new Int32Array(evalNodes.length + 1);
    let total = 0;
    for (const i of evalNodes) total += incoming[i].length;
    this.cSrc = new Int32Array(total);
    this.cW = new Float32Array(total);
    this.cW0 = new Float32Array(total);
    this.cP = new Float32Array(total);
    this.cE = new Float32Array(total);
    const plK: number[] = [];
    const plPost: number[] = [];
    let k = 0;
    evalNodes.forEach((node, e) => {
      this.bias[e] = nodeBias[node];
      this.act[e] = this.nodeActs[node];
      this.cStart[e] = k;
      for (const inc of incoming[node]) {
        this.cSrc[k] = inc.src;
        this.cW[k] = inc.w;
        this.cW0[k] = inc.w;
        this.cP[k] = inc.p;
        this.edgeK[inc.edge] = k;
        if (inc.p !== 0) {
          plK.push(k);
          plPost.push(node);
        }
        k++;
      }
    });
    this.cStart[evalNodes.length] = k;
    this.plK = Int32Array.from(plK);
    this.plPost = Int32Array.from(plPost);
    this.plasticCount = plK.length;
  }

  step(): void {
    const v = this.values;
    const ev = this.evalIdx;
    for (let e = 0; e < ev.length; e++) {
      let s = this.bias[e];
      for (let k = this.cStart[e]; k < this.cStart[e + 1]; k++) s += this.cW[k] * v[this.cSrc[k]];
      let y: number;
      switch (this.act[e]) {
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
      v[ev[e]] = y;
    }
  }

  /**
   * One step of learning: `reward` in [-1, 1] (better or worse than expected), `rate` the genome's
   * learning rate (times the law of nature), `dt` in seconds.
   */
  learn(reward: number, rate: number, dt: number): void {
    const n = this.plK.length;
    if (n === 0) return;
    const { plK, plPost, cSrc, cW, cW0, cP, cE, values } = this;
    const fade = Math.min(1, dt / TRACE_TAU);
    const forget = Math.min(1, dt / FORGET_TAU);
    const gain = rate * reward * LEARN_GAIN * dt;
    for (let q = 0; q < n; q++) {
      const k = plK[q];
      let pre = values[cSrc[k]];
      let post = values[plPost[q]];
      pre = pre > 1 ? 1 : pre < -1 ? -1 : pre;
      post = post > 1 ? 1 : post < -1 ? -1 : post;
      const e = cE[k] + (pre * post - cE[k]) * fade;
      cE[k] = e;
      const w = cW[k] + gain * cP[k] * e + (cW0[k] - cW[k]) * forget;
      cW[k] = w > 6 ? 6 : w < -6 ? -6 : w;
    }
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
