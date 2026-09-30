import { SimHost, createHost, LocalHost } from './host';
import type { Command } from './sim/commands';
import { Archetype } from './sim/genome';
import { Organism } from './sim/organism';
import { GodParams, WORLD_W } from './sim/params';
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

/** Shared application state. UI modules read the world and change it only through commands. */
export class App {
  host: SimHost;
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
  readonly modules: AppModule[] = [];

  constructor(
    readonly renderer: Renderer,
    seed: number,
    width: number,
  ) {
    this.host = createHost(seed, width);
    this.attach(this.host);
  }

  /** The world being shown (in worker mode, the main thread's copy of the simulated one). */
  get world(): World {
    return this.host.world;
  }

  get ready(): boolean {
    return this.host.ready;
  }

  private attach(host: SimHost) {
    host.onReset = (w) => this.setWorld(w);
    host.onSelect = (id) => {
      const o = this.world.orgById.get(id);
      if (o) this.selectOrganism(o);
    };
    host.onFail = (msg) => {
      // no worker: simulate on this thread instead
      console.warn(`Simulation worker unavailable (${msg}); running on the main thread.`);
      const w = this.world;
      this.host = new LocalHost(w.seed, WORLD_W, { ...w.params });
      this.attach(this.host);
      this.setWorld(this.host.world);
    };
  }

  /** Change the world through a command (runs on the simulation thread). */
  cmd(c: Command) {
    this.host.cmd(c);
  }

  /** Change laws of nature: applied here at once (for the sliders) and sent to the simulation. */
  setParams(patch: Partial<GodParams>) {
    Object.assign(this.world.params, patch);
    this.host.cmd({ type: 'params', params: { ...this.world.params } });
  }

  log(text: string, kind: 'god' | 'info' | 'extinct' = 'god') {
    this.cmd({ type: 'log', text, kind });
  }

  newWorld(seed: number, width = this.world.width) {
    this.host.newWorld(seed, width, { ...this.world.params });
  }

  /** A different world (new or loaded) replaced the current one. */
  setWorld(w: World) {
    this.select(null);
    this.highlightSpecies = -1;
    if (this.renderer.worldWidth !== w.width) {
      this.camera.setViewport(this.camera.viewW, this.camera.viewH);
      this.camera.fit();
    }
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

  /** Advance the simulation for this animation frame. */
  simulate(dtReal: number) {
    // the selected organism's id, even once dead (the simulation then says what killed it)
    this.host.frame(dtReal, this.speed, this.paused, this.selectedOrg ? this.selectedOrg.id : -1);
    this.tps = this.paused ? 0 : this.host.tps;
    this.lastStepMs = this.host.stepMs;
  }

  stepOnce() {
    this.host.step();
  }
}
