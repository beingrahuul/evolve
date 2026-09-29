import './style.css';
import { X } from 'lucide';
import { App } from './app';
import { Renderer } from './render/renderer';
import { Dock } from './ui/dock';
import { h, icon } from './ui/dom';
import { GodPanel, TOOL_DEFS } from './ui/godPanel';
import { Input } from './ui/input';
import { Inspector } from './ui/inspector';
import { TopBar } from './ui/topbar';
import { Toasts } from './ui/toasts';
import { TreeView } from './ui/treeView';

const root = document.getElementById('app')!;
const canvas = document.getElementById('world') as HTMLCanvasElement;

function fatal(msg: string) {
  root.append(h('div', { class: 'fatal panel' }, h('h2', {}, 'Primordial could not start'), h('p', {}, msg)));
}

let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (e) {
  fatal(e instanceof Error ? e.message : String(e));
  throw e;
}

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed')) || Math.floor(Math.random() * 1e6);
const app = new App(renderer, seed);

const top = new TopBar(app);
const god = new GodPanel(app);
const inspector = new Inspector(app);
const tree = new TreeView(app);
const dock = new Dock(app, () => tree.open());
const toasts = new Toasts(app);
app.modules.push(top, god, inspector, dock, toasts, tree);
root.append(top.root, god.root, inspector.root, dock.root, toasts.root, tree.root);

// ---- help / welcome --------------------------------------------------------
const help = h(
  'div',
  { id: 'help', class: 'modal hidden' },
  h(
    'div',
    { class: 'modal-card panel' },
    h('button', { class: 'btn icon-btn modal-close', onclick: () => help.classList.add('hidden') }, icon(X, 16)),
    h('h2', {}, 'Welcome, creator'),
    h(
      'p',
      {},
      'This is a primordial ocean. Every cell here has a genome, a small neural-network brain and a metabolism bound by physics and chemistry. Sunlight, heat, sulfide from vents and minerals from weathering rocks feed them. When a cell grows enough it divides, and its child carries slightly mutated genes. Nothing about their bodies or behaviour is scripted: it all evolves.',
    ),
    h(
      'p',
      {},
      'Given time, lineages can become multicellular: a mutation can add a specialised cell (photocyte, mouth, eye, motor, shell, float or fat cell) to the body plan, and bodies grow cell by cell from a small bud. Open the tree of life (T) to watch species branch and die out.',
    ),
    h(
      'p',
      {},
      'You are god. Change the laws of nature, reshape the seabed, or strike with meteors, and watch life adapt. Click anything to inspect it, including a cell (and its brain and body plan), a rock, a vent, the water or the sky. Save your world to a file at any time.',
    ),
    h(
      'div',
      { class: 'keys' },
      ...[
        ['Drag / right-drag', 'Pan'],
        ['Scroll / pinch', 'Zoom'],
        ['Space', 'Pause / play'],
        ['+ / −', 'Change speed'],
        ['.', 'Step one tick'],
        ['F', 'Follow selected cell'],
        ['H', 'Show whole world'],
        ['O', 'Cycle overlays'],
        ['T', 'Tree of life'],
        ['[ / ]', 'Brush size'],
        ['Esc', 'Deselect'],
        ...TOOL_DEFS.map((t) => [t.key.toUpperCase(), t.label]),
      ].map(([k, v]) => h('div', { class: 'key' }, h('kbd', {}, k), h('span', {}, v))),
    ),
    h('button', { class: 'btn primary wide', onclick: () => help.classList.add('hidden') }, 'Let there be life'),
  ),
);
root.append(help);
const toggleHelp = () => help.classList.toggle('hidden');
root.append(h('button', { id: 'helpBtn', class: 'btn panel', title: 'Help (?)', onclick: toggleHelp }, '?'));
try {
  if (!localStorage.getItem('primordial.welcomed')) {
    help.classList.remove('hidden');
    localStorage.setItem('primordial.welcomed', '1');
  }
} catch {
  help.classList.remove('hidden');
}

const input = new Input(app, canvas, god, toggleHelp, () => tree.toggle());

// ---- sizing ------------------------------------------------------------------
function resize() {
  const r = canvas.getBoundingClientRect();
  // the world canvas renders at up to 1.5× device pixels; UI text stays crisp in the DOM
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const g = god.root.getBoundingClientRect();
  const t = top.root.getBoundingClientRect();
  const d = dock.root.getBoundingClientRect();
  app.camera.insets = [g.width ? g.right + 6 : 0, t.bottom + 4, 8, d.height ? r.height - d.top + 6 : 0];
  renderer.resize(r.width, r.height, dpr);
  app.camera.setViewport(r.width, r.height);
}
new ResizeObserver(resize).observe(canvas);
resize();

// ---- main loop ------------------------------------------------------------------
let last = performance.now();
let frame = 0;
const brushTools = new Set(TOOL_DEFS.filter((t) => t.brush).map((t) => t.id));

function loop(now: number) {
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  app.fps = app.fps * 0.95 + (1 / dt) * 0.05;

  input.apply(dt);
  app.simulate(dt);

  const o = app.selectedOrg;
  if (app.follow && o && !o.dead) {
    const cam = app.camera;
    const k = Math.min(1, dt * 6);
    cam.x += (o.x - cam.x) * k;
    cam.y += (o.y - cam.y) * k;
    cam.clamp();
  }
  if (o && o.dead) app.follow = false;

  const p = app.pointer;
  const def = TOOL_DEFS.find((t) => t.id === app.tool)!;
  const showBrush = p.inside && (brushTools.has(app.tool) || app.tool === 'rock');
  renderer.render(app.world, app.camera, {
    time: now / 1000,
    overlay: app.overlay,
    selection: app.selection,
    highlightSpecies: app.highlightSpecies,
    brush: showBrush
      ? { x: p.wx, y: p.wy, r: app.tool === 'rock' ? app.rockSize : app.brush, visible: true, color: def.color }
      : null,
  });
  canvas.style.cursor = app.tool === 'inspect' ? 'default' : showBrush ? 'none' : 'crosshair';

  for (const m of app.modules) m.update(frame);
  frame++;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// expose for debugging in the console
(window as unknown as { primordial: App }).primordial = app;
