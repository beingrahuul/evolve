import { Atom, Moon, Pause, Play, StepForward, Sun } from 'lucide';
import { App, AppModule, SPEEDS } from '../app';
import { TPS } from '../sim/params';
import { fmt, h, icon } from './dom';

export class TopBar implements AppModule {
  readonly root: HTMLElement;
  private clock = h('span', { class: 'clock-text' });
  private clockIcon = h('span', { class: 'clock-icon' });
  private seed = h('span', { class: 'brand-seed' });
  private speedBtns: HTMLButtonElement[] = [];
  private playBtn: HTMLButtonElement;
  private vitals = {
    pop: h('b'),
    species: h('b'),
    o2: h('b'),
    rate: h('b'),
  };
  private isDay = true;
  private lastPaused: boolean | null = null;

  constructor(private app: App) {
    this.playBtn = h('button', { class: 'btn icon-btn', title: 'Pause / play (Space)', onclick: () => this.togglePause() });
    const stepBtn = h(
      'button',
      {
        class: 'btn icon-btn',
        title: 'Step one tick (.)',
        onclick: () => {
          app.paused = true;
          app.stepOnce();
        },
      },
      icon(StepForward, 15),
    );
    const speeds = h('div', { class: 'seg' });
    SPEEDS.forEach((s) => {
      const b = h(
        'button',
        {
          class: 'seg-btn',
          title: s === Infinity ? 'As fast as your computer allows' : `${s}× speed`,
          onclick: () => {
            app.speed = s;
            app.paused = false;
          },
        },
        s === Infinity ? 'Max' : `${s}×`,
      );
      this.speedBtns.push(b);
      speeds.append(b);
    });

    this.root = h(
      'header',
      { id: 'topbar', class: 'panel' },
      h(
        'div',
        { class: 'brand' },
        h('div', { class: 'logo' }, icon(Atom, 20)),
        h('div', {}, h('div', { class: 'brand-title' }, 'Primordial'), this.seed),
      ),
      h('div', { class: 'divider' }),
      h('div', { class: 'clock' }, this.clockIcon, this.clock),
      h('div', { class: 'divider' }),
      h('div', { class: 'controls' }, this.playBtn, stepBtn, speeds),
      h('div', { class: 'divider' }),
      h(
        'div',
        { class: 'vitals' },
        h('span', { title: 'Living organisms' }, 'Life ', this.vitals.pop),
        h('span', { title: 'Living species' }, 'Species ', this.vitals.species),
        h('span', { title: 'Atmospheric oxygen (relative)' }, 'O₂ ', this.vitals.o2),
        h('span', { title: 'Actual simulation speed' }, 'Speed ', this.vitals.rate),
      ),
    );
    this.onWorldChanged();
    this.update(0);
  }

  togglePause() {
    this.app.paused = !this.app.paused;
  }

  onWorldChanged() {
    this.seed.textContent = `seed ${this.app.world.seed}`;
  }

  update(frame: number) {
    const app = this.app;
    const w = app.world;
    if (this.lastPaused !== app.paused) {
      this.lastPaused = app.paused;
      this.playBtn.replaceChildren(icon(app.paused ? Play : Pause, 15));
      this.playBtn.classList.toggle('active', app.paused);
    }
    SPEEDS.forEach((s, i) => this.speedBtns[i].classList.toggle('active', !app.paused && app.speed === s));
    if (frame % 10 !== 0) return;
    const hr = w.hour;
    const hh = Math.floor(hr);
    const mm = Math.floor((hr - hh) * 60);
    this.clock.textContent = `Day ${w.days + 1} · ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    const day = w.sunElev > 0;
    if (day !== this.isDay || !this.clockIcon.firstChild) {
      this.isDay = day;
      this.clockIcon.replaceChildren(icon(day ? Sun : Moon, 16));
      this.clockIcon.classList.toggle('night', !day);
    }
    this.vitals.pop.textContent = fmt(w.orgs.length, 0);
    let sp = 0;
    for (const s of w.species.all) if (s.count > 0) sp++;
    this.vitals.species.textContent = String(sp);
    this.vitals.o2.textContent = (w.fields.atmO2 * 100).toFixed(1);
    this.vitals.rate.textContent = app.paused ? 'paused' : `${(app.tps / TPS).toFixed(1)}×`;
  }
}
