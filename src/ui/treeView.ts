import { GitBranch, X } from 'lucide';
import { App, AppModule } from '../app';
import { TPS } from '../sim/params';
import type { Species } from '../sim/species';
import { h, icon } from './dom';

interface Row {
  sp: Species;
  y: number;
  x0: number;
  x1: number;
  parentRow: Row | null;
}

const LEFT = 16;
const RIGHT = 190;
const TOP = 16;
const BOTTOM = 34;

/** Phylogeny timeline: every lineage as a bar from its origin to its extinction (or now). */
export class TreeView implements AppModule {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scroller: HTMLElement;
  private tip = h('div', { class: 'tree-tip hidden' });
  private summary = h('div', { class: 'tree-summary' });
  private showAll: HTMLInputElement;
  private rows: Row[] = [];
  private rowH = 10;
  private hover: Row | null = null;
  private cw = 0;
  private chh = 0;

  constructor(private app: App) {
    this.canvas = h('canvas', { class: 'tree-canvas' });
    this.ctx = this.canvas.getContext('2d')!;
    this.scroller = h('div', { class: 'tree-scroll' }, this.canvas, this.tip);
    this.showAll = h('input', { type: 'checkbox' }) as HTMLInputElement;
    this.showAll.addEventListener('change', () => this.draw());
    this.root = h(
      'div',
      { id: 'tree', class: 'modal hidden', onclick: (e: Event) => e.target === this.root && this.close() },
      h(
        'div',
        { class: 'modal-card panel tree-card' },
        h(
          'div',
          { class: 'tree-head' },
          icon(GitBranch, 18),
          h('h2', {}, 'Tree of life'),
          this.summary,
          h('label', { class: 'check' }, this.showAll, 'Include short-lived species'),
          h('button', { class: 'btn icon-btn', title: 'Close (T)', onclick: () => this.close() }, icon(X, 16)),
        ),
        h(
          'p',
          { class: 'desc tree-desc' },
          'Each bar is a species, drawn from the moment it branched off its parent to its extinction. Thicker bars had bigger populations; bright bars are still alive. Hover for details; click a living species to find it in the world.',
        ),
        this.scroller,
      ),
    );
    this.canvas.addEventListener('mousemove', (e) => this.onMove(e));
    this.canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.tip.classList.add('hidden');
      this.draw();
    });
    this.canvas.addEventListener('click', () => this.onClick());
  }

  get isOpen() {
    return !this.root.classList.contains('hidden');
  }

  open() {
    this.root.classList.remove('hidden');
    this.draw();
    this.scroller.scrollTop = 0;
  }

  close() {
    this.root.classList.add('hidden');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  onWorldChanged() {
    if (this.isOpen) this.draw();
  }

  update(frame: number) {
    if (this.isOpen && frame % 45 === 0) this.draw();
  }

  private layout() {
    const w = this.app.world;
    const reg = w.species;
    const all = this.showAll.checked;
    const keep = new Set<number>();
    for (const sp of reg.all) {
      if (all || sp.count > 0 || sp.peak >= 5) {
        let s: Species | undefined = sp;
        while (s && !keep.has(s.id)) {
          keep.add(s.id);
          s = s.parentId ? reg.get(s.parentId) : undefined;
        }
      }
    }
    const children = new Map<number, Species[]>();
    const roots: Species[] = [];
    for (const sp of reg.all) {
      if (!keep.has(sp.id)) continue;
      if (sp.parentId && keep.has(sp.parentId)) {
        const list = children.get(sp.parentId) ?? [];
        list.push(sp);
        children.set(sp.parentId, list);
      } else roots.push(sp);
    }
    const order: [Species, Species | null][] = [];
    const visit = (sp: Species, parent: Species | null) => {
      order.push([sp, parent]);
      const kids = (children.get(sp.id) ?? []).sort((a, b) => a.born - b.born);
      for (const k of kids) visit(k, sp);
    };
    roots.sort((a, b) => a.born - b.born).forEach((r) => visit(r, null));
    return order;
  }

  private draw() {
    if (!this.isOpen) return;
    const w = this.app.world;
    const order = this.layout();
    const width = Math.max(400, this.scroller.clientWidth - 2);
    const avail = Math.max(200, this.scroller.clientHeight - 6);
    const n = order.length;
    this.rowH = Math.max(6, Math.min(20, (avail - TOP - BOTTOM) / Math.max(1, n)));
    const height = Math.max(avail, TOP + BOTTOM + n * this.rowH);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (width !== this.cw || height !== this.chh) {
      this.cw = width;
      this.chh = height;
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const now = Math.max(1, w.tick);
    const x = (t: number) => LEFT + (t / now) * (width - LEFT - RIGHT);
    const byId = new Map<number, Row>();
    this.rows = order.map(([sp, parent], i) => {
      const row: Row = {
        sp,
        y: TOP + (i + 0.5) * this.rowH,
        x0: x(sp.born),
        x1: x(sp.extinct >= 0 ? sp.extinct : now),
        parentRow: parent ? (byId.get(parent.id) ?? null) : null,
      };
      byId.set(sp.id, row);
      return row;
    });

    const ctx = this.ctx;
    ctx.clearRect(0, 0, width, height);
    // day grid
    const dayTicks = w.params.dayLength * TPS;
    const days = now / dayTicks;
    const step = Math.max(1, Math.ceil(days / 12));
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.textAlign = 'center';
    for (let d = 0; d <= days; d += step) {
      const gx = x(d * dayTicks);
      ctx.strokeStyle = 'rgba(148,163,184,0.08)';
      ctx.beginPath();
      ctx.moveTo(gx + 0.5, TOP);
      ctx.lineTo(gx + 0.5, height - BOTTOM + 4);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.7)';
      ctx.fillText(`day ${d + 1}`, gx, height - BOTTOM + 16);
    }
    ctx.strokeStyle = 'rgba(94,234,212,0.35)';
    ctx.beginPath();
    ctx.moveTo(x(now) + 0.5, TOP);
    ctx.lineTo(x(now) + 0.5, height - BOTTOM + 4);
    ctx.stroke();

    // branches
    for (const r of this.rows) {
      if (!r.parentRow) continue;
      const hl = this.hover && (this.hover === r || this.hover === r.parentRow);
      ctx.strokeStyle = hl ? 'rgba(226,232,240,0.8)' : 'rgba(148,163,184,0.25)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(r.x0 + 0.5, r.parentRow.y);
      ctx.lineTo(r.x0 + 0.5, r.y);
      ctx.stroke();
    }
    // lifespans
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    let lastLabel = -1e9;
    for (const r of this.rows) {
      const sp = r.sp;
      const alive = sp.count > 0;
      const th = Math.min(this.rowH * 0.8, 1.5 + Math.log2(sp.peak + 1) * 0.9);
      ctx.globalAlpha = alive ? 1 : 0.4;
      ctx.fillStyle = sp.color;
      ctx.fillRect(r.x0, r.y - th / 2, Math.max(1.5, r.x1 - r.x0), th);
      if (alive) {
        ctx.beginPath();
        ctx.arc(r.x1, r.y, Math.max(2, th * 0.7), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (this.hover === r) {
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 1;
        ctx.strokeRect(r.x0 - 2, r.y - th / 2 - 2, Math.max(1.5, r.x1 - r.x0) + 4, th + 4);
      }
      // name living species where there is room (thin rows only label the bigger ones)
      if (alive && r.y - lastLabel >= 11 && (this.rowH >= 9 || sp.count >= 3 || this.hover === r)) {
        lastLabel = r.y;
        ctx.fillStyle = this.hover === r ? '#fff' : 'rgba(226,232,240,0.85)';
        ctx.font = 'italic 10.5px ui-sans-serif, system-ui';
        ctx.fillText(`${sp.name}  ${sp.count}`, x(now) + 10, r.y);
      }
    }
    const alive = w.species.alive().length;
    this.summary.textContent = `${w.species.all.length} species have lived · ${alive} alive · showing ${n}`;
  }

  private onMove(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let hit: Row | null = null;
    for (const r of this.rows) {
      if (Math.abs(r.y - my) <= Math.max(3, this.rowH / 2) && mx >= r.x0 - 4 && mx <= r.x1 + 120) {
        hit = r;
        break;
      }
    }
    if (hit !== this.hover) {
      this.hover = hit;
      this.draw();
    }
    if (!hit) {
      this.tip.classList.add('hidden');
      return;
    }
    const w = this.app.world;
    const sp = hit.sp;
    const day = (t: number) => Math.floor(t / TPS / w.params.dayLength) + 1;
    const parent = sp.parentId ? w.species.get(sp.parentId) : undefined;
    this.tip.replaceChildren(
      h('b', {}, sp.name),
      h('div', {}, sp.role),
      h('div', {}, parent ? `Branched from ${parent.name} on day ${day(sp.born)}` : `Founding lineage (day ${day(sp.born)})`),
      h('div', {}, sp.count > 0 ? `${sp.count} alive now · peak ${sp.peak}` : `Extinct on day ${day(sp.extinct)} · peak ${sp.peak}`),
      h('div', {}, `${sp.total} individuals ever born`),
    );
    this.tip.classList.remove('hidden');
    const sr = this.scroller.getBoundingClientRect();
    this.tip.style.left = `${Math.min(e.clientX - sr.left + 14, sr.width - 250)}px`;
    this.tip.style.top = `${e.clientY - sr.top + this.scroller.scrollTop + 14}px`;
  }

  private onClick() {
    const r = this.hover;
    if (!r || r.sp.count <= 0) return;
    const app = this.app;
    app.highlightSpecies = r.sp.id;
    let best = null;
    for (const o of app.world.orgs) if (o.species === r.sp.id && (!best || o.mass > best.mass)) best = o;
    if (best) app.selectOrganism(best, true);
    this.close();
  }
}
