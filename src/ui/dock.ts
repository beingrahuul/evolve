import { ChevronDown, GitBranch } from 'lucide';
import { App, AppModule } from '../app';
import { TPS } from '../sim/params';
import { h, icon } from './dom';

type Mode = 'species' | 'roles' | 'atmosphere' | 'evolution';

const ROLE_COLORS = { photo: '#4ade80', chemo: '#fb923c', hetero: '#f87171', land: '#c08a57' };

/** Bottom dock: population history chart and the list of living species. */
export class Dock implements AppModule {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private list = h('div', { class: 'species-list' });
  private legend = h('div', { class: 'chart-legend' });
  private mode: Mode = 'species';
  private modeBtns = new Map<Mode, HTMLButtonElement>();
  private cw = 0;
  private ch = 0;

  constructor(
    private app: App,
    private onTree: () => void,
  ) {
    this.canvas = h('canvas', { class: 'chart' });
    this.ctx = this.canvas.getContext('2d')!;
    const modes = h('div', { class: 'seg small' });
    (
      [
        ['species', 'Species'],
        ['roles', 'Lifestyles'],
        ['atmosphere', 'Atmosphere'],
        ['evolution', 'Behaviour'],
      ] as [Mode, string][]
    ).forEach(([m, label]) => {
      const b = h('button', { class: 'seg-btn', onclick: () => this.setMode(m) }, label);
      this.modeBtns.set(m, b);
      modes.append(b);
    });
    const toggle = h(
      'button',
      { class: 'btn icon-btn dock-toggle', title: 'Collapse / expand', onclick: () => this.root.classList.toggle('collapsed') },
      icon(ChevronDown, 15),
    );
    const treeBtn = h(
      'button',
      { class: 'btn tree-btn', title: 'Open the tree of life (T)', onclick: () => this.onTree() },
      icon(GitBranch, 14),
      h('span', {}, 'Tree of life'),
    );
    this.root = h(
      'section',
      { id: 'dock', class: 'panel' },
      h(
        'div',
        { class: 'dock-chart' },
        h('div', { class: 'dock-head' }, h('span', { class: 'dock-title' }, 'History of life'), modes, this.legend, toggle),
        h('div', { class: 'chart-wrap' }, this.canvas),
      ),
      h('div', { class: 'dock-species' }, h('div', { class: 'dock-head' }, h('span', { class: 'dock-title' }, 'Living species'), treeBtn), this.list),
    );
    this.setMode('species');
  }

  private setMode(m: Mode) {
    this.mode = m;
    for (const [k, b] of this.modeBtns) b.classList.toggle('active', k === m);
    this.draw();
  }

  onWorldChanged() {
    this.draw();
    this.renderList();
  }

  update(frame: number) {
    if (frame % 30 === 0) {
      this.draw();
      this.renderList();
    }
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(10, Math.round(r.width));
    const hh = Math.max(10, Math.round(r.height));
    if (w !== this.cw || hh !== this.ch) {
      this.cw = w;
      this.ch = hh;
      this.canvas.width = w * dpr;
      this.canvas.height = hh * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  private draw() {
    if (this.root.classList.contains('collapsed')) return;
    this.resize();
    const ctx = this.ctx;
    const W = this.cw;
    const H = this.ch;
    ctx.clearRect(0, 0, W, H);
    const samples = this.app.world.stats.samples;
    const n = samples.length;
    // grid
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = Math.round((H * i) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    if (n < 2) {
      ctx.fillStyle = 'rgba(148,163,184,0.6)';
      ctx.font = '12px system-ui';
      ctx.fillText('Collecting history…', 10, H / 2);
      this.legend.textContent = '';
      return;
    }
    const x = (i: number) => (i / (n - 1)) * W;
    const legendItems: [string, string][] = [];

    if (this.mode === 'atmosphere' || this.mode === 'evolution') {
      const evo = this.mode === 'evolution';
      // births come in bursts (by day, when a lineage is ready): average the sexual share over half a minute
      const smooth = (i: number) => {
        let b = 0;
        let sx = 0;
        for (let k = Math.max(0, i - 29); k <= i; k++) {
          b += samples[k].births ?? 0;
          sx += (samples[k].births ?? 0) * (samples[k].sexual ?? 0);
        }
        return b ? sx / b : 0;
      };
      const series: [string, string, (s: (typeof samples)[number], i: number) => number][] = evo
        ? [
            ['Sexual births', '#fb7185', (_s, i) => smooth(i)],
            ['Sex drive', '#f9a8d4', (s) => s.sexDrive ?? 0],
            ['Learners', '#facc15', (s) => s.learners ?? 0],
            ['Signalling', '#a78bfa', (s) => s.signalers ?? 0],
          ]
        : [
            ['O₂', '#7dd3fc', (s) => s.atmO2],
            ['CO₂', '#fbbf24', (s) => s.atmCO2],
            ['Water °C', '#f472b6', (s) => s.meanTemp / 30],
            ['Cloud %', '#cbd5e1', (s) => s.cloud ?? 0],
          ];
      let max = 0;
      samples.forEach((s, i) => {
        for (const [, , f] of series) max = Math.max(max, f(s, i));
      });
      max = evo ? Math.max(0.2, max * 1.1) : max * 1.1 || 1;
      for (const [name, col, f] of series) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        samples.forEach((s, i) => {
          const y = H - (f(s, i) / max) * H;
          if (i === 0) ctx.moveTo(x(i), y);
          else ctx.lineTo(x(i), y);
        });
        ctx.stroke();
        const last = f(samples[n - 1], n - 1);
        legendItems.push([
          col,
          evo ? `${name} ${(last * 100).toFixed(0)}%` : `${name} ${name === 'Water °C' ? (last * 30).toFixed(1) : (last * 100).toFixed(1)}`,
        ]);
      }
    } else {
      // stacked area
      let keys: string[];
      let colors: string[];
      let getter: (s: (typeof samples)[number]) => number[];
      if (this.mode === 'roles') {
        keys = ['Phototrophs', 'Chemotrophs', 'Heterotrophs', 'On land'];
        colors = [ROLE_COLORS.photo, ROLE_COLORS.chemo, ROLE_COLORS.hetero, ROLE_COLORS.land];
        getter = (s) => [s.photo, s.chemo, s.hetero, s.land ?? 0];
      } else {
        const peak = new Map<number, number>();
        for (const s of samples) for (const [id, c] of s.species) peak.set(id, Math.max(peak.get(id) ?? 0, c));
        const top = [...peak.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9).map((e) => e[0]);
        const reg = this.app.world.species;
        keys = top.map((id) => reg.get(id)?.name ?? `#${id}`).concat('Others');
        colors = top.map((id) => reg.get(id)?.color ?? '#888').concat('rgba(148,163,184,0.5)');
        getter = (s) => {
          const m = new Map(s.species);
          const vals = top.map((id) => m.get(id) ?? 0);
          const sum = vals.reduce((a, b) => a + b, 0);
          vals.push(Math.max(0, s.pop - sum));
          return vals;
        };
      }
      const data = samples.map(getter);
      let max = 0;
      for (const d of data) max = Math.max(max, d.reduce((a, b) => a + b, 0));
      max = max * 1.08 || 1;
      const base = new Float32Array(n);
      for (let k = 0; k < keys.length; k++) {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const y = H - ((base[i] + data[i][k]) / max) * H;
          if (i === 0) ctx.moveTo(x(i), y);
          else ctx.lineTo(x(i), y);
        }
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(x(i), H - (base[i] / max) * H);
        ctx.closePath();
        ctx.fillStyle = colors[k];
        ctx.globalAlpha = 0.78;
        ctx.fill();
        ctx.globalAlpha = 1;
        for (let i = 0; i < n; i++) base[i] += data[i][k];
      }
      ctx.fillStyle = 'rgba(226,232,240,0.7)';
      ctx.font = '11px system-ui';
      ctx.fillText(String(Math.round(max / 1.08)), 4, 12);
      if (this.mode === 'roles') keys.forEach((k, i) => legendItems.push([colors[i], `${k} ${data[n - 1][i]}`]));
    }
    const span = ((samples[n - 1].tick - samples[0].tick) / TPS / 60).toFixed(1);
    ctx.fillStyle = 'rgba(148,163,184,0.7)';
    ctx.font = '11px system-ui';
    ctx.textAlign = 'right';
    ctx.fillText(`last ${span} min`, W - 4, H - 4);
    ctx.textAlign = 'left';
    this.legend.replaceChildren(...legendItems.map(([c, t]) => h('span', {}, h('i', { style: { background: c } }), t)));
  }

  private renderList() {
    const app = this.app;
    const alive = app.world.species.alive().sort((a, b) => b.count - a.count);
    const rows: HTMLElement[] = alive.slice(0, 12).map((sp) =>
      h(
        'button',
        {
          class: `species-row ${app.highlightSpecies === sp.id ? 'active' : ''}`,
          title: 'Click to highlight members; double-click to follow the biggest one',
          onclick: () => {
            app.highlightSpecies = app.highlightSpecies === sp.id ? -1 : sp.id;
            this.renderList();
          },
          ondblclick: () => {
            let best = null;
            for (const o of app.world.orgs) if (o.species === sp.id && (!best || o.mass > best.mass)) best = o;
            if (best) app.selectOrganism(best, true);
          },
        },
        h('i', { class: 'chip-dot', style: { background: sp.color } }),
        h('span', { class: 'sp-name' }, sp.name),
        h('span', { class: 'sp-role' }, sp.role),
        h('b', { class: 'sp-count' }, String(sp.count)),
      ),
    );
    if (alive.length > 12) rows.push(h('div', { class: 'sp-more' }, `+ ${alive.length - 12} rarer species`));
    if (!alive.length) rows.push(h('div', { class: 'sp-more' }, 'No life… yet.'));
    this.list.replaceChildren(...rows);
  }
}
