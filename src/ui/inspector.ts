import { Copy, Crosshair, Dna, Heart, Highlighter, Skull, Trash2, X } from 'lucide';
import { App, AppModule } from '../app';
import { ALLOC_COLORS, ALLOC_NAMES, NALLOC } from '../sim/genome';
import { Organism } from '../sim/organism';
import { BIO, CHEM, WORLD_H } from '../sim/params';
import { hueColor } from '../sim/species';
import { richness } from '../sim/terrain';
import { BodyView, bodySummary } from './bodyView';
import { BrainView } from './brainView';
import { bar, fmt, h, icon, kvGrid, pct, section } from './dom';

type IconNode = Parameters<typeof icon>[0];

const COMPASS = ['→ east', '↘ south-east', '↓ down', '↙ south-west', '← west', '↖ north-west', '↑ up', '↗ north-east'];
const dirName = (dx: number, dy: number) => COMPASS[(Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) + 8) % 8];

export class Inspector implements AppModule {
  readonly root: HTMLElement;
  private head: HTMLElement;
  private chip = h('span', { class: 'chip-dot' });
  private title = h('div', { class: 'insp-title' });
  private subtitle = h('div', { class: 'insp-sub' });
  private body = h('div', { class: 'insp-body' });
  private updater: (() => void) | null = null;
  private brain = new BrainView();
  private bodyView = new BodyView();

  constructor(private app: App) {
    const close = h('button', { class: 'btn icon-btn', title: 'Close (Esc)', onclick: () => app.select(null) }, icon(X, 15));
    this.head = h('div', { class: 'insp-head' }, this.chip, h('div', { class: 'insp-titles' }, this.title, this.subtitle), close);
    this.root = h('aside', { id: 'inspector', class: 'panel hidden' }, this.head, this.body);
  }

  onWorldChanged() {
    this.onSelection();
  }

  onSelection() {
    const sel = this.app.selection;
    this.body.replaceChildren();
    this.updater = null;
    if (!sel) {
      this.root.classList.add('hidden');
      return;
    }
    this.root.classList.remove('hidden');
    this.body.scrollTop = 0;
    switch (sel.kind) {
      case 'organism': {
        const o = this.app.selectedOrg;
        if (o) this.buildOrganism(o);
        break;
      }
      case 'rock':
        this.buildRock(sel.id);
        break;
      case 'vent':
        this.buildVent(sel.id);
        break;
      case 'water':
        this.buildWater(sel.x, sel.y);
        break;
      case 'sky':
        this.buildSky(sel.x);
        break;
      case 'floor':
        this.buildFloor(sel.x, sel.y);
        break;
      case 'particle':
        this.buildParticle(sel.uid);
        break;
    }
    (this.updater as (() => void) | null)?.();
  }

  update(frame: number) {
    if (this.updater && frame % 8 === 0) this.updater();
  }

  private setHead(title: string, sub: string, color: string) {
    this.title.textContent = title;
    this.subtitle.textContent = sub;
    this.chip.style.background = color;
  }

  private action(ic: IconNode, label: string, fn: () => void, cls = '') {
    return h('button', { class: `btn ${cls}`, onclick: fn }, icon(ic, 14), h('span', {}, label));
  }

  // ---------------------------------------------------------------------------
  // Organism
  // ---------------------------------------------------------------------------

  private buildOrganism(o: Organism) {
    const app = this.app;
    const w = app.world;
    const role = h('div', { class: 'role' });
    const status = h('div', { class: 'status' });
    const deathNote = h('div', { class: 'death hidden' });

    const followBtn = this.action(Crosshair, 'Follow', () => {
      app.follow = !app.follow;
    });
    const hlBtn = this.action(Highlighter, 'Species', () => {
      app.highlightSpecies = app.highlightSpecies === o.species ? -1 : o.species;
    });
    const actions = h(
      'div',
      { class: 'actions' },
      followBtn,
      hlBtn,
      this.action(Copy, 'Clone', () => {
        const c = w.clone(o);
        if (c) w.log(`You cloned organism #${o.id}.`, 'god');
      }),
      this.action(Heart, 'Feed', () => {
        o.energy = o.ecap;
        o.health = 1;
        o.nutrient = o.mass * BIO.NUT_RATIO * 1.5;
      }),
      this.action(Dna, 'Mutate', () => {
        w.mutateOrganism(o, 5);
        this.onSelection();
      }),
      this.action(Skull, 'Kill', () => w.kill(o, 'Struck down by god'), 'danger'),
    );

    const vit = {
      energy: bar('Energy', '#facc15'),
      health: bar('Health', '#4ade80'),
      growth: bar('Growth', '#60a5fa'),
      age: bar('Age', '#a78bfa'),
    };
    const stats = kvGrid(['Mass', 'Radius', 'Speed', 'Depth', 'Water', 'Children', 'Kills', 'Travelled', 'Born']);

    const srcColors = ['#4ade80', '#fb923c', '#fde68a', '#f87171'];
    const srcNames = ['Sunlight', 'Chemosynthesis', 'Detritus', 'Prey'];
    const srcBar = h('div', { class: 'stack' });
    const srcSegs = srcColors.map((c) => {
      const s = h('div', { class: 'stack-seg', style: { background: c } });
      srcBar.append(s);
      return s;
    });
    const srcLegend = h('div', { class: 'legend' });
    const srcLabels = srcNames.map((n, i) => {
      const v = h('b');
      srcLegend.append(h('span', {}, h('i', { style: { background: srcColors[i] } }), `${n} `, v));
      return v;
    });

    const organs = h('div', { class: 'bars' });
    const organBars = ALLOC_NAMES.map((n, i) => {
      const b = bar(n, ALLOC_COLORS[i]);
      organs.append(b.root);
      return b;
    });

    const genes = kvGrid(['Divides at', 'Ideal temp', 'Lifespan', 'Mutation rate', 'Inner clock', 'Toxin resist', 'Signature']);
    const bodyCaption = h('div', { class: 'caption' });
    const bodySection = section('Body plan', h('div', { class: 'brain-wrap' }, this.bodyView.canvas), bodyCaption);
    const brainCaption = h('div', { class: 'caption' });

    this.body.append(
      role,
      actions,
      deathNote,
      section('Vitals', vit.energy.root, vit.health.root, vit.growth.root, vit.age.root, status),
      bodySection,
      section('Body', stats.root),
      section('Where its energy comes from', srcBar, srcLegend),
      section('Cell anatomy', organs),
      section('Genome', genes.root),
      section('Brain', h('div', { class: 'brain-wrap' }, this.brain.canvas), brainCaption),
    );

    this.updater = () => {
      const sp = w.species.get(o.species);
      this.setHead(sp ? sp.name : 'Unknown species', `Organism #${o.id} · generation ${o.generation}`, sp ? sp.color : hueColor(o.genome.hue));
      let origin = '';
      if (sp) {
        const parent = sp.parentId ? w.species.get(sp.parentId) : undefined;
        const day = Math.floor(sp.born / 60 / w.params.dayLength) + 1;
        origin = parent ? ` · evolved on day ${day} from ${parent.name}` : ' · a founding lineage';
      }
      role.textContent = `${w.diet(o)} · ${sp ? `${sp.count} alive` : ''}${origin}`;
      followBtn.classList.toggle('active', app.follow);
      hlBtn.classList.toggle('active', app.highlightSpecies === o.species);
      if (o.dead) {
        deathNote.classList.remove('hidden');
        deathNote.textContent = `Died at age ${o.age.toFixed(0)} s: ${o.cause}.`;
        actions.classList.add('disabled');
      }
      const g = o.genome;
      vit.energy.set(o.energy / o.ecap, `${fmt(Math.max(0, o.energy))} / ${fmt(o.ecap)}`);
      vit.health.set(o.health, pct(o.health));
      vit.growth.set(o.mass / g.divMass, `${pct(o.mass / g.divMass)} to split`);
      const life = g.lifespan * (1 + 0.12 * g.body.length);
      vit.age.set(o.age / life, `${o.age.toFixed(0)} / ${life.toFixed(0)} s`);
      const parts: string[] = [];
      parts.push(o.thrust > 0.08 && o.frac[3] > 0.02 ? `swimming ${pct(o.thrust)}` : 'drifting');
      if (Math.abs(o.turn) > 0.25) parts.push(o.turn > 0 ? 'turning right' : 'turning left');
      if (o.digesting > 0) parts.push('digesting a meal');
      else if (o.eating) parts.push('mouth open');
      if (o.frac[6] > 0.03) parts.push(o.inflate > 0.6 ? 'rising' : o.inflate < 0.35 ? 'sinking' : 'hovering');
      if (o.glow > 0.2) parts.push('glowing');
      if (o.touching) parts.push(`touching ${o.touching}`);
      if (o.pain > 0.2) parts.push('in pain!');
      status.textContent = parts.join(' · ');

      const ci = w.fields.cellIndex(o.x, o.y);
      stats.set('Mass', fmt(o.mass, 2));
      stats.set('Radius', `${o.radius.toFixed(1)} µm`);
      stats.set('Speed', `${Math.hypot(o.vx, o.vy).toFixed(1)} µm/s`);
      stats.set('Depth', `${o.y.toFixed(0)} µm (${pct(o.y / WORLD_H)})`);
      stats.set('Water', `${w.fields.temp[ci].toFixed(1)} °C`);
      stats.set('Children', String(o.children));
      stats.set('Kills', String(o.kills));
      stats.set('Travelled', `${fmt(o.travelled, 0)} µm`);
      stats.set('Born', `day ${Math.floor(o.born / 60 / w.params.dayLength) + 1}`);

      const src = [o.eLight, o.eChem, o.eFood, o.ePrey];
      const tot = src.reduce((a, b) => a + b, 0) || 1;
      src.forEach((v, i) => {
        srcSegs[i].style.width = `${(v / tot) * 100}%`;
        srcLabels[i].textContent = pct(v / tot);
      });

      for (let i = 0; i < NALLOC; i++) organBars[i].set(o.frac[i] / 0.6, pct(o.frac[i]));

      genes.set('Divides at', `mass ${g.divMass.toFixed(1)}`);
      genes.set('Ideal temp', `${g.tempOpt.toFixed(1)} ± ${g.tempTol.toFixed(1)} °C`);
      genes.set('Lifespan', `${g.lifespan.toFixed(0)} s`);
      genes.set('Mutation rate', `${g.mutRate.toFixed(2)}×`);
      genes.set('Inner clock', `${g.oscFreq.toFixed(2)} Hz`);
      genes.set('Toxin resist', pct(o.resist));
      genes.set('Signature', g.sig.map((s) => s.toFixed(2)).join(' · '));

      this.bodyView.draw(o);
      const target = o.targetCells;
      bodyCaption.textContent =
        target === 1
          ? 'Single-celled. A mutation can add specialised cells to its body plan.'
          : `${o.nCells} of ${target} cells grown: ${bodySummary(o)}. Buds off a small propagule to reproduce.`;
      this.brain.draw(o);
      brainCaption.textContent = `${o.brain.hiddenCount} hidden neurons · ${o.brain.connCount} synapses. Teal = excite, red = inhibit. Bright nodes are firing.`;
    };
  }

  // ---------------------------------------------------------------------------
  // Environment
  // ---------------------------------------------------------------------------

  private buildRock(id: number) {
    const w = this.app.world;
    const rock = w.terrain.rocks.find((r) => r.id === id);
    if (!rock) return;
    const t = rock.type;
    const col = `rgb(${t.color.map((c) => Math.round(c * 255)).join(',')})`;
    this.setHead(`${t.name} stone`, `Rock #${rock.id}`, col);
    const kv = kvGrid(['Radius', 'Eroded', 'Hardness', 'Leached', 'Weathering', 'Water here']);
    const m = t.minerals;
    const minerals = h(
      'div',
      { class: 'bars' },
      ...[
        ['Iron', m.iron, '#f97316'],
        ['Calcium', m.calcium, '#e5e7eb'],
        ['Silica', m.silica, '#93c5fd'],
        ['Phosphate', m.phosphate, '#86efac'],
      ].map(([n, v, c]) => {
        const b = bar(n as string, c as string);
        b.set(v as number, pct(v as number));
        return b.root;
      }),
    );
    this.body.append(
      h('p', { class: 'desc' }, t.desc, ' Weathering releases minerals that feed life nearby.'),
      h('div', { class: 'actions' }, this.action(Trash2, 'Remove rock', () => {
        w.removeRock(rock.id);
        this.app.select(null);
      }, 'danger')),
      section('Properties', kv.root),
      section('Mineral composition', minerals),
    );
    this.updater = () => {
      const ci = w.fields.cellIndex(rock.x, rock.y - rock.r - 8);
      const rate = CHEM.EROSION * w.params.erosion * rock.r * (1 - t.hardness) * richness(m) * 4;
      kv.set('Radius', `${rock.r.toFixed(1)} µm`);
      kv.set('Eroded', pct(1 - (rock.r * rock.r) / (rock.r0 * rock.r0), 2));
      kv.set('Hardness', pct(t.hardness));
      kv.set('Leached', `${rock.released.toFixed(2)} nutrients`);
      kv.set('Weathering', `~${(rate * 60).toFixed(3)} / min`);
      kv.set('Water here', `${w.fields.temp[ci].toFixed(1)} °C`);
    };
  }

  private buildVent(id: number) {
    const w = this.app.world;
    const vent = w.terrain.vents.find((v) => v.id === id);
    if (!vent) return;
    this.setHead('Hydrothermal vent', `Vent #${vent.id}`, '#fb923c');
    const kv = kvGrid(['Mouth temp', 'Sulfide out', 'Minerals out', 'CO₂ out', 'Life nearby']);
    const power = h('input', { type: 'range', min: 0, max: 4, step: 0.05, value: vent.power }) as HTMLInputElement;
    const pv = h('span', { class: 'slider-val' });
    power.addEventListener('input', () => (vent.power = Number(power.value)));
    this.body.append(
      h(
        'p',
        { class: 'desc' },
        'A crack in the seafloor where superheated, mineral-rich water gushes out. Hydrogen sulfide from vents is poison to most cells, but chemotrophs turn it into energy without any sunlight.',
      ),
      section('Power', h('label', { class: 'slider' }, h('div', { class: 'slider-top' }, h('span', {}, 'Vent power'), pv), power)),
      section('Output', kv.root),
      h('div', { class: 'actions' }, this.action(Trash2, 'Seal vent', () => {
        w.removeVent(vent.id);
        this.app.select(null);
      }, 'danger')),
    );
    this.updater = () => {
      const pw = vent.power * w.params.vents;
      const ci = w.fields.cellIndex(vent.x, vent.y - 12);
      pv.textContent = `${vent.power.toFixed(2)}×`;
      kv.set('Mouth temp', `${w.fields.temp[ci].toFixed(1)} °C`);
      kv.set('Sulfide out', `${(CHEM.VENT_SULFIDE * pw).toFixed(2)} /s`);
      kv.set('Minerals out', `${(CHEM.VENT_NUTRIENT * pw).toFixed(3)} /s`);
      kv.set('CO₂ out', `${(CHEM.VENT_CO2 * pw).toFixed(2)} /s`);
      let n = 0;
      for (const o of w.orgs) if (Math.hypot(o.x - vent.x, o.y - vent.y) < 150) n++;
      kv.set('Life nearby', String(n));
    };
  }

  private buildWater(x: number, y: number) {
    const w = this.app.world;
    this.setHead('Seawater', `at x ${x.toFixed(0)} µm, depth ${y.toFixed(0)} µm`, '#38bdf8');
    const kv = kvGrid(['Temperature', 'Oxygen', 'CO₂', 'Nutrients', 'Sulfide', 'Sunlight', 'Current', 'Life nearby', 'Detritus']);
    const note = h('p', { class: 'desc' });
    this.body.append(section('Water chemistry', kv.root), note);
    this.updater = () => {
      const F = w.fields;
      const ci = F.cellIndex(x, y);
      F.sampleVel(x, y);
      const speed = Math.hypot(F.su, F.sv);
      const sat = F.o2[ci] / CHEM.O2_EQ;
      kv.set('Temperature', `${F.temp[ci].toFixed(1)} °C`);
      kv.set('Oxygen', `${F.o2[ci].toFixed(2)} (${pct(sat)} sat.)`);
      kv.set('CO₂', F.co2[ci].toFixed(2));
      kv.set('Nutrients', F.nut[ci].toFixed(3));
      kv.set('Sulfide', F.sulf[ci].toFixed(2));
      kv.set('Sunlight', w.sunNow > 0.01 ? pct(F.light[ci] / w.sunNow) + ' of surface' : 'night');
      kv.set('Current', speed < 0.3 ? 'still' : `${speed.toFixed(1)} µm/s ${dirName(F.su, F.sv)}`);
      let n = 0;
      for (const o of w.orgs) if (Math.hypot(o.x - x, o.y - y) < 80) n++;
      let p = 0;
      const P = w.particles;
      for (let i = 0; i < P.n; i++) if (Math.hypot(P.x[i] - x, P.y[i] - y) < 80) p++;
      kv.set('Life nearby', String(n));
      kv.set('Detritus', `${p} particles`);
      const hints: string[] = [];
      if (sat < 0.25) hints.push('Low oxygen: cells here must ferment, which wastes energy.');
      if (F.sulf[ci] > 0.6) hints.push('Sulfide is toxic here to cells without chemosynthesis.');
      if (F.temp[ci] > 35) hints.push('Hot water from a vent.');
      if (F.nut[ci] < 0.05) hints.push('Nutrient-poor: growth is limited.');
      note.textContent = hints.join(' ');
    };
  }

  private buildSky(x: number) {
    const w = this.app.world;
    this.setHead('Atmosphere', 'The air above the ocean', '#7dd3fc');
    const kv = kvGrid(['Time', 'Sun', 'Air temp', 'Wind', 'Oxygen', 'CO₂', 'Weather']);
    this.body.append(
      section('Air', kv.root),
      h(
        'p',
        { class: 'desc' },
        'The atmosphere trades gases with the ocean surface. Photosynthesis slowly adds oxygen to it and respiration adds CO₂. Wind drags the surface water into currents.',
      ),
    );
    this.updater = () => {
      const F = w.fields;
      const hr = w.hour;
      const wind = F.windAt(x, w.params);
      kv.set('Time', `day ${w.days + 1}, ${String(Math.floor(hr)).padStart(2, '0')}:${String(Math.floor((hr % 1) * 60)).padStart(2, '0')}`);
      kv.set('Sun', w.sunElev > 0 ? `${pct(w.sunNow / Math.max(0.01, w.params.sun))} high · ${pct(w.params.sun)} strength` : 'below the horizon');
      kv.set('Air temp', `${F.airTemp.toFixed(1)} °C`);
      kv.set('Wind', Math.abs(wind) < 0.05 ? 'calm' : `${(Math.abs(wind) * 20).toFixed(0)} km/h ${wind > 0 ? 'eastward →' : '← westward'}`);
      kv.set('Oxygen', `${(F.atmO2 * 100).toFixed(2)} (relative)`);
      kv.set('CO₂', `${(F.atmCO2 * 100).toFixed(2)} (relative)`);
      const ws = Math.abs(wind);
      kv.set('Weather', ws > 1.6 ? 'Stormy' : ws > 0.6 ? 'Windy, clear' : ws > 0.15 ? 'Breezy, clear' : 'Calm, clear');
    };
  }

  private buildFloor(x: number, y: number) {
    const w = this.app.world;
    this.setHead('Seafloor sediment', `at x ${x.toFixed(0)} µm`, '#a8a29e');
    const kv = kvGrid(['Floor depth', 'Water above', 'Nutrients', 'Resting detritus', 'Buried carbon']);
    this.body.append(
      section('Sediment', kv.root),
      h(
        'p',
        { class: 'desc' },
        'Dead matter rains down as marine snow and settles here. Bacteria decompose it back into CO₂ and nutrients; some of it is buried and leaves the cycle.',
      ),
    );
    this.updater = () => {
      const fy = w.terrain.floorY(x);
      const ci = w.fields.cellIndex(x, fy - 8);
      let n = 0;
      let c = 0;
      const P = w.particles;
      for (let i = 0; i < P.n; i++) {
        if (P.rest[i] > 0 && Math.abs(P.x[i] - x) < 60) {
          n++;
          c += P.c[i];
        }
      }
      kv.set('Floor depth', `${fy.toFixed(0)} µm`);
      kv.set('Water above', `${w.fields.temp[ci].toFixed(1)} °C, O₂ ${w.fields.o2[ci].toFixed(1)}`);
      kv.set('Nutrients', w.fields.nut[ci].toFixed(3));
      kv.set('Resting detritus', `${n} particles (${c.toFixed(1)} C)`);
      kv.set('Buried carbon', `${w.sediment.c.toFixed(0)} C worldwide`);
      void y;
    };
  }

  private buildParticle(uid: number) {
    const w = this.app.world;
    this.setHead('Detritus', 'Dead organic matter', '#fde68a');
    const kv = kvGrid(['Carbon', 'Nutrients', 'Age', 'State', 'Decay']);
    this.body.append(
      section('Particle', kv.root),
      h('p', { class: 'desc' }, 'The remains of a dead cell. Scavengers can eat it; otherwise bacteria slowly break it down.'),
    );
    this.updater = () => {
      const P = w.particles;
      const i = P.indexOfUid(uid);
      if (i < 0) {
        kv.set('State', 'eaten or fully decomposed');
        return;
      }
      const ci = w.fields.cellIndex(P.x[i], P.y[i]);
      const T = w.fields.temp[ci];
      const tf = Math.min(2, Math.max(0.3, Math.pow(2, (T - 20) / 10)));
      kv.set('Carbon', P.c[i].toFixed(2));
      kv.set('Nutrients', P.nu[i].toFixed(3));
      kv.set('Age', `${P.age[i].toFixed(0)} s`);
      kv.set('State', P.rest[i] > 0 ? 'resting on the floor' : 'sinking');
      kv.set('Decay', `${(BIO.DECAY * w.params.decay * tf * 100).toFixed(2)}% per s`);
    };
  }
}

