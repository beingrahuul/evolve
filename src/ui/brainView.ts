import { INPUT_NAMES, NI, NO, OUTPUT_NAMES } from '../sim/genome';
import type { Organism } from '../sim/organism';

const W = 316;
const H = 452;

/** Live drawing of an organism's neural network: node colour = activation, edge colour = weight sign. */
export class BrainView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pos = new Float32Array(0);
  private layoutFor: unknown = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'brain-canvas';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }

  private layout(o: Organism) {
    const b = o.brain;
    if (this.layoutFor === b) return;
    this.layoutFor = b;
    const n = b.n;
    this.pos = new Float32Array(n * 2);
    const top = 12;
    const rowH = (H - 24) / (NI - 1);
    const xIn = 118;
    const xOut = W - 58;
    for (let i = 0; i < NI; i++) {
      this.pos[i * 2] = xIn;
      this.pos[i * 2 + 1] = top + i * rowH;
    }
    for (let k = 0; k < NO; k++) {
      const i = NI + k;
      this.pos[i * 2] = xOut;
      this.pos[i * 2 + 1] = H / 2 + (k - (NO - 1) / 2) * 44;
    }
    const hidden: number[] = [];
    for (let i = NI + NO; i < n; i++) hidden.push(i);
    hidden.sort((a, c) => b.order[a] - b.order[c]);
    hidden.forEach((i, k) => {
      const x0 = xIn + 34;
      const x1 = xOut - 34;
      this.pos[i * 2] = x0 + b.order[i] * (x1 - x0);
      const slot = (k + 0.5) / hidden.length;
      this.pos[i * 2 + 1] = top + 10 + slot * (H - 44) + (k % 2 ? 8 : -8);
    });
  }

  draw(o: Organism) {
    this.layout(o);
    const ctx = this.ctx;
    const b = o.brain;
    const v = b.values;
    const pos = this.pos;
    ctx.clearRect(0, 0, W, H);

    // edges (plastic synapses are dashed; what they have learned shows in gold)
    for (let e = 0; e < b.edgeSrc.length; e++) {
      const s = b.edgeSrc[e];
      const d = b.edgeDst[e];
      const w = b.edgeWeight(e);
      const plastic = b.isPlastic(e);
      const x1 = pos[s * 2];
      const y1 = pos[s * 2 + 1];
      const x2 = pos[d * 2];
      const y2 = pos[d * 2 + 1];
      const act = Math.min(1, Math.abs(v[s]));
      const alpha = Math.min(1, Math.abs(w) / 3) * (0.15 + 0.85 * act);
      const learned = plastic ? Math.min(1, Math.abs(b.edgeLearned(e)) * 1.5) : 0;
      const base = w > 0 ? [94, 234, 212] : [251, 113, 133];
      const col = base.map((c, i) => Math.round(c + ([250, 204, 21][i] - c) * learned));
      ctx.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, ${Math.max(alpha, learned * 0.8)})`;
      ctx.lineWidth = 0.6 + Math.min(2.5, Math.abs(w) * 0.5);
      ctx.setLineDash(plastic ? [3, 2] : []);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      if (x2 > x1 + 4) {
        const mx = (x1 + x2) / 2;
        ctx.bezierCurveTo(mx, y1, mx, y2, x2, y2);
      } else {
        // recurrent connection: loop over the top
        const lift = 30 + Math.abs(x1 - x2) * 0.15;
        ctx.bezierCurveTo(x1 + 30, y1 - lift, x2 - 30, y2 - lift, x2, y2);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // nodes
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < b.n; i++) {
      const x = pos[i * 2];
      const y = pos[i * 2 + 1];
      const a = Math.max(-1, Math.min(1, v[i]));
      const r = i < NI ? 3.6 : i < NI + NO ? 6 : 4.8;
      const col =
        a >= 0 ? `rgba(94, 234, 212, ${0.2 + 0.8 * a})` : `rgba(251, 113, 133, ${0.2 + 0.8 * -a})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#0b1220';
      ctx.fill();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = i >= NI + NO ? 'rgba(196, 181, 253, 0.9)' : 'rgba(148, 163, 184, 0.5)';
      ctx.stroke();
      if (i < NI) {
        ctx.textAlign = 'right';
        ctx.fillStyle = Math.abs(a) > 0.02 ? 'rgba(226, 232, 240, 0.9)' : 'rgba(148, 163, 184, 0.55)';
        ctx.fillText(INPUT_NAMES[i], x - 40, y);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.8)';
        ctx.fillText(a.toFixed(2), x - 7, y);
      } else if (i < NI + NO) {
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(226, 232, 240, 0.95)';
        ctx.fillText(OUTPUT_NAMES[i - NI], x + 10, y - 6);
        ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
        ctx.fillText(a.toFixed(2), x + 10, y + 6);
      }
    }
  }
}
