import {
  Atom,
  Biohazard,
  Bubbles,
  ChevronDown,
  CloudLightning,
  CloudRain,
  Cookie,
  Dices,
  Egg,
  FlameKindling,
  FlaskConical,
  FolderOpen,
  HardDriveDownload,
  HardDriveUpload,
  Save,
  Flame,
  MousePointer2,
  Mountain,
  MountainSnow,
  PanelLeftClose,
  PanelLeftOpen,
  Pickaxe,
  RotateCcw,
  Skull,
  Snowflake,
  Sprout,
  Sun,
  ThermometerSun,
  Wind,
  Zap,
} from 'lucide';
import { App, AppModule, Tool } from '../app';
import { ARCHETYPE_LABELS, Archetype } from '../sim/genome';
import { GodParams, WORLD_SIZES, WorldSize, defaultParams, worldSizeOf } from '../sim/params';
import { ROCK_TYPES } from '../sim/terrain';
import { h, icon } from './dom';
import { downloadBlob, pickFile, quickLoad, quickSave, quickSaveMeta } from './saveLoad';

type IconNode = Parameters<typeof icon>[0];

export interface ToolDef {
  id: Tool;
  label: string;
  icon: IconNode;
  key: string;
  hint: string;
  brush: boolean;
  color: [number, number, number];
}

export const TOOL_DEFS: ToolDef[] = [
  { id: 'inspect', label: 'Inspect', icon: MousePointer2, key: '1', hint: 'Click anything to see its properties. Drag to pan, scroll to zoom.', brush: false, color: [0.6, 1, 1] },
  { id: 'spawn', label: 'Create life', icon: Sprout, key: '2', hint: 'Click in the sea or on land to create an organism.', brush: false, color: [0.5, 1, 0.6] },
  { id: 'food', label: 'Food', icon: Cookie, key: '3', hint: 'Hold to sprinkle dead organic matter (detritus).', brush: true, color: [1, 0.9, 0.6] },
  { id: 'heat', label: 'Heat', icon: Flame, key: '4', hint: 'Hold to heat the water.', brush: true, color: [1, 0.5, 0.3] },
  { id: 'cool', label: 'Cool', icon: Snowflake, key: '5', hint: 'Hold to chill the water.', brush: true, color: [0.5, 0.8, 1] },
  { id: 'nutrients', label: 'Minerals', icon: FlaskConical, key: '6', hint: 'Hold to dissolve nutrients (N, P, Fe) into the water.', brush: true, color: [0.6, 1, 0.5] },
  { id: 'sulfide', label: 'Sulfide', icon: Biohazard, key: '7', hint: 'Hold to release hydrogen sulfide: food for chemotrophs, poison for others.', brush: true, color: [1, 0.9, 0.3] },
  { id: 'current', label: 'Current', icon: Wind, key: '8', hint: 'Drag to push the water around.', brush: true, color: [0.6, 0.8, 1] },
  { id: 'rock', label: 'Rock', icon: Mountain, key: '9', hint: 'Click to place a boulder.', brush: false, color: [0.8, 0.75, 0.7] },
  { id: 'vent', label: 'Vent', icon: FlameKindling, key: '0', hint: 'Click near the seafloor to open a hydrothermal vent.', brush: false, color: [1, 0.6, 0.2] },
  { id: 'smite', label: 'Smite', icon: Zap, key: 'x', hint: 'Click or hold to strike down organisms.', brush: true, color: [1, 0.35, 0.35] },
  { id: 'rain', label: 'Rain cloud', icon: CloudRain, key: 'r', hint: 'Hold in the sky to seed rain clouds.', brush: true, color: [0.75, 0.85, 1] },
  { id: 'lightning', label: 'Lightning', icon: CloudLightning, key: 'l', hint: 'Click to call down lightning. Over the sea it forges organic molecules; on land it fixes nitrogen.', brush: false, color: [0.9, 0.9, 1] },
  { id: 'raise', label: 'Raise land', icon: MountainSnow, key: 'g', hint: 'Hold to push the ground up: build islands, mountains and shallows.', brush: true, color: [0.85, 0.7, 0.5] },
  { id: 'lower', label: 'Dig', icon: Pickaxe, key: 'b', hint: 'Hold to lower the ground: carve bays and deepen the sea.', brush: true, color: [0.55, 0.7, 0.9] },
];

interface SliderDef {
  key: keyof GodParams;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (v: number) => string;
  hint: string;
}

const SLIDERS: SliderDef[] = [
  { key: 'sun', label: 'Sunlight', min: 0, max: 2.5, step: 0.05, format: (v) => `${Math.round(v * 100)}%`, hint: 'Energy arriving from the sun.' },
  { key: 'dayLength', label: 'Day length', min: 20, max: 600, step: 10, format: (v) => `${v.toFixed(0)} s`, hint: 'Seconds per day/night cycle.' },
  { key: 'tempOffset', label: 'Climate', min: -20, max: 20, step: 0.5, format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} °C`, hint: 'Shifts air and deep-water temperature.' },
  { key: 'mutation', label: 'Mutation', min: 0, max: 5, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'How much offspring differ from parents.' },
  { key: 'viscosity', label: 'Viscosity', min: 0.3, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'How thick the water is: harder to swim, slower to sink.' },
  { key: 'gravity', label: 'Gravity', min: 0, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'How fast heavy things sink.' },
  { key: 'wind', label: 'Wind', min: 0, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'Wind drives surface currents and mixing.' },
  { key: 'vents', label: 'Vent activity', min: 0, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'Heat, sulfide and minerals from hydrothermal vents.' },
  { key: 'erosion', label: 'Erosion', min: 0, max: 5, step: 0.1, format: (v) => `${v.toFixed(1)}×`, hint: 'How fast rocks weather into nutrients.' },
  { key: 'decay', label: 'Decay', min: 0, max: 4, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'How fast bacteria decompose dead matter.' },
  { key: 'tides', label: 'Tides', min: 0, max: 1.6, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'How far the sea rises and falls twice a day.' },
  { key: 'humidity', label: 'Humidity', min: 0, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'How much water evaporates: a wet or an arid climate.' },
  { key: 'storms', label: 'Storms', min: 0, max: 3, step: 0.05, format: (v) => `${v.toFixed(2)}×`, hint: 'How violent convection is: thunderstorms and lightning.' },
  { key: 'learning', label: 'Learning', min: 0, max: 3, step: 0.05, format: (v) => (v === 0 ? 'off' : `${v.toFixed(2)}×`), hint: 'How fast plastic synapses learn from reward during a lifetime (0 = instinct only).' },
  { key: 'pheromones', label: 'Pheromones', min: 0, max: 3, step: 0.05, format: (v) => (v === 0 ? 'none' : `${v.toFixed(2)}×`), hint: 'How long chemical signals linger in the water (0 = cells cannot signal).' },
];

export const OVERLAYS = ['None', 'Temp', 'O₂', 'CO₂', 'Nutrients', 'Sulfide', 'Light', 'Flow', 'Humidity', 'Signals'];

export class GodPanel implements AppModule {
  readonly root: HTMLElement;
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private toolHint = h('div', { class: 'tool-hint' });
  private toolOpts = h('div', { class: 'tool-opts' });
  private sliderSync: (() => void)[] = [];
  private overlayBtns: HTMLButtonElement[] = [];
  private seedInput: HTMLInputElement;
  private sizeSelect: HTMLSelectElement;
  private sizeHint = h('div', { class: 'tool-hint' });
  private autoSeed: HTMLInputElement;
  private simInfo = h('div', { class: 'tool-hint' });
  private brandSeed = h('span', { class: 'brand-seed' });
  private collapseBtn = h('button', { class: 'btn icon-btn collapse-btn', onclick: () => this.toggleCollapsed() });

  constructor(private app: App) {
    const tools = h('div', { class: 'tool-grid' });
    for (const t of TOOL_DEFS) {
      const b = h(
        'button',
        { class: 'tool-btn', title: `${t.label} (${t.key.toUpperCase()})`, onclick: () => this.setTool(t.id) },
        icon(t.icon, 17),
        h('span', {}, t.label),
        h('kbd', {}, t.key.toUpperCase()),
      );
      this.toolBtns.set(t.id, b);
      tools.append(b);
    }

    const sliders = h('div', { class: 'sliders' });
    for (const s of SLIDERS) sliders.append(this.slider(s));

    const acts = h(
      'div',
      { class: 'acts' },
      this.act(CloudLightning, 'Meteor strike', 'A meteor hits the seafloor', () => app.cmd({ type: 'act', act: 'meteor' })),
      this.act(Bubbles, 'Eruption', 'Vents surge; CO₂ floods the air', () => app.cmd({ type: 'act', act: 'eruption' })),
      this.act(FlaskConical, 'Nutrient bloom', 'Minerals everywhere', () => app.cmd({ type: 'act', act: 'bloom' })),
      this.act(Snowflake, 'Ice age', 'Climate −12 °C', () => {
        app.setParams({ tempOffset: -12 });
        app.log('An ice age begins. The climate cools by 12 °C.');
      }),
      this.act(ThermometerSun, 'Heat wave', 'Climate +12 °C', () => {
        app.setParams({ tempOffset: 12 });
        app.log('A heat wave grips the world. The climate warms by 12 °C.');
      }),
      this.act(CloudLightning, 'Thunderstorm', 'Build a storm over the sea', () => app.cmd({ type: 'act', act: 'thunderstorm' })),
      this.act(Sun, 'Drought', 'Dry the air and the land', () => app.cmd({ type: 'act', act: 'drought' })),
      this.act(Skull, 'Extinction', 'Kill 90% of life', () => app.cmd({ type: 'act', act: 'extinction' })),
      this.act(Egg, 'Seed life', 'Scatter new protocells', () => app.cmd({ type: 'act', act: 'seed' })),
      this.act(RotateCcw, 'Reset laws', 'Restore default physics', () => {
        const d = defaultParams();
        d.autoSeed = app.world.params.autoSeed;
        app.setParams(d);
      }),
    );

    const overlays = h('div', { class: 'chips' });
    OVERLAYS.forEach((name, i) => {
      const b = h('button', { class: 'chip', onclick: () => (app.overlay = i) }, name);
      this.overlayBtns.push(b);
      overlays.append(b);
    });

    this.seedInput = h('input', { class: 'input', type: 'number', value: String(app.world.seed), title: 'World seed' });
    this.sizeSelect = h('select', { class: 'input', title: 'Size of the next world' }) as HTMLSelectElement;
    for (const [k, v] of Object.entries(WORLD_SIZES)) this.sizeSelect.append(h('option', { value: k }, `${v.label} world`));
    this.sizeSelect.value = worldSizeOf(app.world.width);
    const showSize = () => {
      const def = WORLD_SIZES[this.sizeSelect.value as WorldSize];
      this.sizeHint.textContent = `${def.hint} ${def.width} µm wide.`;
    };
    this.sizeSelect.addEventListener('change', showSize);
    showSize();
    this.autoSeed = h('input', { type: 'checkbox', checked: app.world.params.autoSeed });
    this.autoSeed.addEventListener('change', () => app.setParams({ autoSeed: this.autoSeed.checked }));
    const world = h(
      'div',
      { class: 'world-row' },
      this.seedInput,
      h(
        'button',
        {
          class: 'btn',
          title: 'Random seed',
          onclick: () => {
            this.seedInput.value = String(Math.floor(Math.random() * 1e6));
          },
        },
        icon(Dices, 15),
      ),
      h(
        'button',
        {
          class: 'btn primary',
          onclick: () =>
            app.newWorld(Math.floor(Number(this.seedInput.value) || 1), WORLD_SIZES[this.sizeSelect.value as WorldSize].width),
        },
        'New world',
      ),
    );

    const saveRow = h(
      'div',
      { class: 'acts' },
      this.act(Save, 'Save file', 'Download this world as a .primordial file', () => this.run('save')),
      this.act(FolderOpen, 'Open file', 'Load a .primordial file', () => this.run('open')),
      this.act(HardDriveDownload, 'Quick save', 'Save to this browser', () => this.run('qsave')),
      this.act(HardDriveUpload, 'Quick load', 'Load the browser quick save', () => this.run('qload')),
    );

    this.root = h(
      'aside',
      { id: 'god' },
      h(
        'div',
        { class: 'brand' },
        h('div', { class: 'logo' }, icon(Atom, 20)),
        h('div', { class: 'brand-text' }, h('div', { class: 'brand-title' }, 'Primordial'), this.brandSeed),
        this.collapseBtn,
      ),
      this.group('Tools', true, tools, this.toolOpts, this.toolHint),
      this.group('Laws of nature', true, sliders),
      this.group('Acts of god', false, acts),
      this.group('View', true, overlays),
      this.group(
        'World',
        false,
        world,
        this.sizeSelect,
        this.sizeHint,
        h('label', { class: 'check' }, this.autoSeed, 'Re-seed life if everything dies'),
        this.simInfo,
        h('div', { class: 'sub-title' }, 'Save & load'),
        saveRow,
        this.saveInfo,
      ),
    );
    this.refreshSaveInfo();
    this.setTool(app.tool);
    this.onWorldChanged();
    let collapsed = false;
    try {
      collapsed = localStorage.getItem('primordial.sidebar') === 'collapsed';
    } catch {
      // storage unavailable: start expanded
    }
    this.setCollapsed(collapsed);
  }

  /** Minimise the sidebar to a rail of tool icons (M), or expand it again. */
  toggleCollapsed() {
    this.setCollapsed(!this.root.classList.contains('collapsed'));
  }

  private setCollapsed(on: boolean) {
    this.root.classList.toggle('collapsed', on);
    this.collapseBtn.replaceChildren(icon(on ? PanelLeftOpen : PanelLeftClose, 16));
    this.collapseBtn.title = on ? 'Expand the sidebar (M)' : 'Minimise the sidebar (M)';
    try {
      localStorage.setItem('primordial.sidebar', on ? 'collapsed' : 'open');
    } catch {
      // not remembered
    }
  }

  private saveInfo = h('div', { class: 'tool-hint' });
  private busy = false;

  private async refreshSaveInfo() {
    const meta = await quickSaveMeta();
    const size = meta?.width && meta.width !== 1920 ? `${WORLD_SIZES[worldSizeOf(meta.width)].label.toLowerCase()} world, ` : '';
    this.saveInfo.textContent = meta
      ? `Quick save: ${size}seed ${meta.seed}, day ${meta.day}, ${meta.population} organisms (${new Date(meta.savedAt).toLocaleString()}).`
      : 'No quick save yet.';
  }

  private async run(op: 'save' | 'open' | 'qsave' | 'qload') {
    if (this.busy) return;
    this.busy = true;
    const app = this.app;
    try {
      if (op === 'save') {
        const blob = await app.host.save();
        downloadBlob(blob, app.world);
        app.log(`World saved to a file (${(blob.size / 1024).toFixed(0)} KB).`, 'info');
      } else if (op === 'open') {
        const blob = await pickFile();
        if (blob) await app.host.load(blob);
      } else if (op === 'qsave') {
        await quickSave(await app.host.save(), app.world);
        app.log('World quick-saved in this browser.', 'info');
        this.refreshSaveInfo();
      } else {
        const blob = await quickLoad();
        if (blob) await app.host.load(blob);
        else app.log('There is no quick save yet.', 'info');
      }
    } catch (e) {
      app.log(`Could not ${op === 'save' || op === 'qsave' ? 'save' : 'load'}: ${e instanceof Error ? e.message : e}`, 'extinct');
    } finally {
      this.busy = false;
    }
  }

  private group(title: string, open: boolean, ...children: HTMLElement[]) {
    const body = h('div', { class: 'group-body' }, ...children);
    const g = h(
      'section',
      { class: `group ${open ? 'open' : ''}` },
      h(
        'button',
        { class: 'group-head', onclick: () => g.classList.toggle('open') },
        h('span', {}, title),
        icon(ChevronDown, 14),
      ),
      body,
    );
    return g;
  }

  private act(ic: IconNode, label: string, hint: string, fn: () => void) {
    return h('button', { class: 'act-btn', title: hint, onclick: fn }, icon(ic, 15), h('span', {}, label));
  }

  private slider(s: SliderDef) {
    const app = this.app;
    const val = h('span', { class: 'slider-val' });
    const input = h('input', { type: 'range', min: s.min, max: s.max, step: s.step }) as HTMLInputElement;
    const fmt = s.format ?? ((v: number) => v.toFixed(2));
    input.addEventListener('input', () => {
      app.setParams({ [s.key]: Number(input.value) });
      val.textContent = fmt(Number(input.value));
    });
    input.addEventListener('dblclick', () => {
      app.setParams({ [s.key]: defaultParams()[s.key] });
    });
    const sync = () => {
      const v = app.world.params[s.key] as number;
      if (document.activeElement !== input && Number(input.value) !== v) input.value = String(v);
      const t = fmt(v);
      if (val.textContent !== t) val.textContent = t;
    };
    this.sliderSync.push(sync);
    sync();
    return h(
      'label',
      { class: 'slider', title: `${s.hint} (double-click to reset)` },
      h('div', { class: 'slider-top' }, h('span', {}, s.label), val),
      input,
    );
  }

  setTool(t: Tool) {
    const app = this.app;
    app.tool = t;
    for (const [id, b] of this.toolBtns) b.classList.toggle('active', id === t);
    const def = TOOL_DEFS.find((d) => d.id === t)!;
    this.toolHint.textContent = def.hint;
    this.toolOpts.replaceChildren();
    if (def.brush) {
      const input = h('input', { type: 'range', min: 10, max: 240, step: 1, value: app.brush }) as HTMLInputElement;
      const v = h('span', { class: 'slider-val' }, String(app.brush));
      input.addEventListener('input', () => {
        app.brush = Number(input.value);
        v.textContent = input.value;
      });
      this.toolOpts.append(h('label', { class: 'slider' }, h('div', { class: 'slider-top' }, h('span', {}, 'Brush size  [ ]'), v), input));
    }
    if (t === 'spawn') {
      const sel = h('select', { class: 'input' }) as HTMLSelectElement;
      for (const [k, label] of Object.entries(ARCHETYPE_LABELS)) {
        sel.append(h('option', { value: k, selected: k === app.spawnArch }, label));
      }
      sel.addEventListener('change', () => (app.spawnArch = sel.value as Archetype));
      this.toolOpts.append(sel);
    }
    if (t === 'rock') {
      const sel = h('select', { class: 'input' }) as HTMLSelectElement;
      ROCK_TYPES.forEach((rt, i) => sel.append(h('option', { value: i, selected: i === app.rockType }, rt.name)));
      sel.addEventListener('change', () => (app.rockType = Number(sel.value)));
      const size = h('input', { type: 'range', min: 10, max: 80, value: app.rockSize }) as HTMLInputElement;
      size.addEventListener('input', () => (app.rockSize = Number(size.value)));
      this.toolOpts.append(sel, h('label', { class: 'slider' }, h('div', { class: 'slider-top' }, h('span', {}, 'Rock size')), size));
    }
  }

  onWorldChanged() {
    const w = this.app.world;
    this.brandSeed.textContent = `seed ${w.seed} · ${WORLD_SIZES[worldSizeOf(w.width)].label.toLowerCase()} world`;
    this.seedInput.value = String(this.app.world.seed);
    this.sizeSelect.value = worldSizeOf(this.app.world.width);
    this.sizeSelect.dispatchEvent(new Event('change'));
    this.autoSeed.checked = this.app.world.params.autoSeed;
  }

  update(frame: number) {
    this.overlayBtns.forEach((b, i) => b.classList.toggle('active', this.app.overlay === i));
    if (frame % 15 === 0) for (const s of this.sliderSync) s();
    if (frame % 30 === 0) {
      const app = this.app;
      const where = app.host.kind === 'worker' ? 'on its own thread (Web Worker)' : 'on the main thread';
      this.simInfo.textContent = `Simulating ${where}: ${app.lastStepMs.toFixed(2)} ms per tick, up to ~${Math.round(1000 / Math.max(0.05, app.lastStepMs) / 60)}× real time.`;
    }
  }
}
