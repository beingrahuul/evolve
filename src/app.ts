import { Archetype } from './sim/genome';
import { Organism } from './sim/organism';
import { TPS } from './sim/params';
import { Selection, World } from './sim/world';
import { Camera } from './render/camera';
import { Renderer } from './render/renderer';

export type Tool =
  | 'inspect'
  | 'spawn'
  | 'food'
  | 'heat'
  | 'cool'
  | 'nutrients'
  | 'sulfide'
  | 'current'
  | 'rock'
  | 'vent'
  | 'smite'
  | 'rain'
  | 'lightning'
  | 'raise'
  | 'lower';

export const SPEEDS = [1, 3, 10, 30, Infinity];

export interface AppModule {
  update(frame: number): void;
  onWorldChanged?(): void;
  onSelection?(): void;
}

/** Shared application state; UI modules read and mutate it. */
export class App {
  world: World;
  readonly camera = new Camera();
  tool: Tool = 'inspect';
  brush = 55;
  spawnArch: Archetype = 'photo';
  rockType = 0;
  rockSize = 32;
  paused = false;
  speed = 1;
  overlay = 0;
  selection: Selection | null = null;
  selectedOrg: Organism | null = null;
  follow = false;
  highlightSpecies = -1;
  pointer = { sx: 0, sy: 0, wx: 0, wy: 0, inside: false, down: false };
  fps = 60;
  tps = 0;
  lastStepMs = 0;
  private acc = 0;
  readonly modules: AppModule[] = [];

  constructor(
    readonly renderer: Renderer,
    seed: number,
  ) {
    this.world = new World(seed);
  }

  newWorld(seed: number) {
    this.setWorld(new World(seed, { ...this.world.params }));
  }

  /** Swap in a different world (new or loaded). */
  setWorld(w: World) {
    this.world = w;
    this.select(null);
    this.highlightSpecies = -1;
    for (const m of this.modules) m.onWorldChanged?.();
  }

  select(sel: Selection | null) {
    this.selection = sel;
    this.selectedOrg = sel && sel.kind === 'organism' ? (this.world.orgById.get(sel.id) ?? null) : null;
    if (!this.selectedOrg) this.follow = false;
    for (const m of this.modules) m.onSelection?.();
  }

  selectOrganism(o: Organism, follow = false) {
    this.select({ kind: 'organism', id: o.id });
    this.follow = follow;
  }

  /** Run as many ticks as the speed setting asks for, within a time budget. */
  simulate(dtReal: number) {
    if (this.paused) {
      this.tps = 0;
      return;
    }
    const budget = this.speed === Infinity ? 26 : 16;
    let wanted: number;
    if (this.speed === Infinity) wanted = 100000;
    else {
      this.acc = Math.min(this.acc + dtReal * TPS * this.speed, TPS * this.speed * 0.25);
      wanted = Math.floor(this.acc);
      this.acc -= wanted;
    }
    const t0 = performance.now();
    let n = 0;
    while (n < wanted) {
      this.world.step();
      n++;
      if (performance.now() - t0 > budget) {
        this.acc = 0;
        break;
      }
    }
    if (n > 0) this.lastStepMs = (performance.now() - t0) / n;
    const inst = n / Math.max(1e-3, dtReal);
    this.tps = this.tps * 0.9 + inst * 0.1;
  }

  stepOnce() {
    this.world.step();
  }
}
