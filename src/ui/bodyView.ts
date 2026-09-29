import { CELL_TYPE_COLORS, CELL_TYPE_NAMES, CT } from '../sim/genome';
import type { Organism } from '../sim/organism';

const W = 316;
const H = 150;

/** Diagram of an organism's body plan: each cell coloured by its specialisation. */
export class BodyView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'body-canvas';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = W * dpr;
    this.canvas.height = H * dpr;
    this.ctx = this.canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }

  draw(o: Organism) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, W, H);
    const n = o.nCells;
    const scale = (Math.min(W, H) * 0.42) / Math.max(0.5, o.bodyR);
    const cx = W / 2;
    const cy = H / 2;
    // forward arrow
    const ar = o.bodyR * scale + 14;
    ctx.strokeStyle = 'rgba(148,163,184,0.45)';
    ctx.fillStyle = 'rgba(148,163,184,0.45)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(cx + ar - 12, cy);
    ctx.lineTo(cx + ar, cy);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + ar + 5, cy);
    ctx.lineTo(cx + ar - 1, cy - 4);
    ctx.lineTo(cx + ar - 1, cy + 4);
    ctx.fill();
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('front', cx + ar - 4, cy - 9);

    for (let i = 0; i < n; i++) {
      const x = cx + o.cx[i] * scale;
      const y = cy + o.cy[i] * scale;
      const r = o.cr[i] * scale;
      const t = o.ctype[i];
      const col = CELL_TYPE_COLORS[t];
      const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
      g.addColorStop(0, col + 'cc');
      g.addColorStop(1, col + '44');
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.lineWidth = t === CT.Armor ? 3 : 1.4;
      ctx.strokeStyle = col;
      ctx.stroke();
      if (t === CT.Core) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.35, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(88, 28, 135, 0.8)';
        ctx.fill();
      }
    }
  }
}

/** "3 photocytes · 1 float cell" style summary of a body. */
export function bodySummary(o: Organism): string {
  const counts = new Map<number, number>();
  for (let i = 0; i < o.nCells; i++) counts.set(o.ctype[i], (counts.get(o.ctype[i]) ?? 0) + 1);
  const parts: string[] = [];
  for (const [t, c] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    const name = CELL_TYPE_NAMES[t].toLowerCase();
    parts.push(`${c} ${c > 1 ? name.replace('cell', 'cells').replace(/cyte$/, 'cytes') : name}`);
  }
  return parts.join(' · ');
}
