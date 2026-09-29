import { App, SPEEDS, Tool } from '../app';
import { FieldBrush } from '../sim/world';
import { GodPanel, OVERLAYS, TOOL_DEFS } from './godPanel';

const FIELD_TOOLS: Partial<Record<Tool, FieldBrush>> = {
  heat: 'heat',
  cool: 'cool',
  nutrients: 'nutrients',
  sulfide: 'sulfide',
};

/** Mouse, trackpad and keyboard controls. */
export class Input {
  private dragging = false;
  private panning = false;
  private moved = 0;
  private lastX = 0;
  private lastY = 0;
  private lastWX = 0;
  private lastWY = 0;
  private activePointer = -1;

  constructor(
    private app: App,
    private canvas: HTMLCanvasElement,
    private god: GodPanel,
    private onHelp: () => void,
    private onTree: () => void,
  ) {
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointerenter', () => (app.pointer.inside = true));
    canvas.addEventListener('pointerleave', () => (app.pointer.inside = false));
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.key(e));
  }

  private toWorld(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const [wx, wy] = this.app.camera.screenToWorld(sx, sy);
    const p = this.app.pointer;
    p.sx = sx;
    p.sy = sy;
    p.wx = wx;
    p.wy = wy;
    return p;
  }

  private down(e: PointerEvent) {
    if (this.activePointer !== -1) return;
    this.activePointer = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    const p = this.toWorld(e);
    this.moved = 0;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastWX = p.wx;
    this.lastWY = p.wy;
    const app = this.app;
    if (e.button === 1 || e.button === 2 || app.tool === 'inspect') {
      this.panning = true;
      return;
    }
    this.dragging = true;
    p.down = true;
    const w = app.world;
    switch (app.tool) {
      case 'spawn': {
        const o = w.spawn(app.spawnArch, p.wx, p.wy);
        if (o) app.selectOrganism(o);
        break;
      }
      case 'lightning':
        w.callLightning(p.wx);
        break;
      case 'rock':
        if (p.wy > w.seaLevel - 420) {
          w.placeRock(p.wx, p.wy, app.rockSize, app.rockType);
          w.log('You raised a new rock from the depths.', 'god');
        }
        break;
      case 'vent':
        w.placeVent(p.wx);
        w.log('A new hydrothermal vent cracks open on the seafloor.', 'god');
        break;
      case 'smite': {
        const n = w.smite(p.wx, p.wy, app.brush);
        if (n) w.log(`You struck down ${n} organism${n > 1 ? 's' : ''}.`, 'god');
        break;
      }
    }
  }

  private move(e: PointerEvent) {
    const p = this.toWorld(e);
    if (e.pointerId !== this.activePointer) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.panning) {
      if (this.moved > 3) {
        this.app.camera.pan(dx, dy);
        this.app.follow = false;
      }
      return;
    }
    if (this.dragging && this.app.tool === 'current') {
      const k = 0.9;
      this.app.world.pushFlow(p.wx, p.wy, (p.wx - this.lastWX) * k, (p.wy - this.lastWY) * k, this.app.brush);
    }
    this.lastWX = p.wx;
    this.lastWY = p.wy;
  }

  private up(e: PointerEvent) {
    if (e.pointerId !== this.activePointer) return;
    this.activePointer = -1;
    const p = this.toWorld(e);
    const app = this.app;
    if (this.panning && this.moved <= 3 && e.button === 0) {
      const tol = 8 / app.camera.zoom + 2;
      app.select(app.world.pick(p.wx, p.wy, tol));
    }
    this.panning = false;
    this.dragging = false;
    p.down = false;
  }

  private wheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.toWorld(e);
    const scale = e.deltaMode === 1 ? 0.05 : 0.0015;
    const factor = Math.exp(-e.deltaY * scale * (e.ctrlKey ? 4 : 1));
    this.app.camera.zoomAt(p.sx, p.sy, factor);
  }

  /** Continuous brush effects while the pointer is held. */
  apply(dt: number) {
    const app = this.app;
    const p = app.pointer;
    if (!this.dragging || !p.down) return;
    const w = app.world;
    const field = FIELD_TOOLS[app.tool];
    if (field) w.paintField(field, p.wx, p.wy, app.brush, dt);
    else if (app.tool === 'food') w.addFood(p.wx, p.wy, app.brush, Math.max(1, Math.round(app.brush * app.brush * 0.0004)));
    else if (app.tool === 'smite') w.smite(p.wx, p.wy, app.brush);
    else if (app.tool === 'rain') w.seedClouds(p.wx, p.wy, app.brush, dt);
    else if (app.tool === 'raise') w.terraform(p.wx, app.brush, -70 * dt);
    else if (app.tool === 'lower') w.terraform(p.wx, app.brush, 70 * dt);
  }

  private key(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const app = this.app;
    const k = e.key.toLowerCase();
    const tool = TOOL_DEFS.find((d) => d.key === k);
    if (tool) {
      this.god.setTool(tool.id);
      return;
    }
    switch (k) {
      case ' ':
        e.preventDefault();
        app.paused = !app.paused;
        break;
      case '.':
        app.paused = true;
        app.stepOnce();
        break;
      case '[':
        app.brush = Math.max(10, app.brush - 10);
        this.god.setTool(app.tool);
        break;
      case ']':
        app.brush = Math.min(240, app.brush + 10);
        this.god.setTool(app.tool);
        break;
      case 'f':
        if (app.selectedOrg && !app.selectedOrg.dead) app.follow = !app.follow;
        break;
      case 'h':
        app.camera.fit();
        app.follow = false;
        break;
      case 'o':
        app.overlay = (app.overlay + 1) % OVERLAYS.length;
        break;
      case '=':
      case '+': {
        const i = SPEEDS.indexOf(app.speed);
        app.speed = SPEEDS[Math.min(SPEEDS.length - 1, i + 1)];
        app.paused = false;
        break;
      }
      case '-': {
        const i = SPEEDS.indexOf(app.speed);
        app.speed = SPEEDS[Math.max(0, i - 1)];
        break;
      }
      case '?':
        this.onHelp();
        break;
      case 't':
        this.onTree();
        break;
      case 'escape':
        if (app.selection) app.select(null);
        else this.god.setTool('inspect');
        break;
    }
  }
}
