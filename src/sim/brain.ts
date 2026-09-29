import { Genome, NI, NO } from './genome';

/**
 * A compiled neural network. Nodes are evaluated in genome `order`; a connection from a node that
 * has not been evaluated yet this tick reads its previous value, which gives recurrence (memory)
 * for free.
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
  private cW: Float32Array;

  // For visualisation
  readonly order: Float32Array;
  readonly nodeActs: Uint8Array;
  readonly edgeSrc: Int32Array;
  readonly edgeDst: Int32Array;
  readonly edgeW: Float32Array;
  readonly hiddenCount: number;
  readonly connCount: number;

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

    const incoming: { src: number; w: number }[][] = [];
    for (let i = 0; i < this.n; i++) incoming.push([]);
    const es: number[] = [];
    const ed: number[] = [];
    const ew: number[] = [];
    for (const c of g.conns) {
      if (!c.on) continue;
      const s = indexOf.get(c.from);
      const d = indexOf.get(c.to);
      if (s === undefined || d === undefined || d < NI) continue;
      incoming[d].push({ src: s, w: c.w });
      es.push(s);
      ed.push(d);
      ew.push(c.w);
    }
    this.edgeSrc = Int32Array.from(es);
    this.edgeDst = Int32Array.from(ed);
    this.edgeW = Float32Array.from(ew);
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
    let k = 0;
    evalNodes.forEach((node, e) => {
      this.bias[e] = nodeBias[node];
      this.act[e] = this.nodeActs[node];
      this.cStart[e] = k;
      for (const inc of incoming[node]) {
        this.cSrc[k] = inc.src;
        this.cW[k] = inc.w;
        k++;
      }
    });
    this.cStart[evalNodes.length] = k;
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

  output(k: number): number {
    const y = this.values[NI + k];
    return y > 1 ? 1 : y < -1 ? -1 : y;
  }
}
