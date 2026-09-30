import './style.css';
import { X } from 'lucide';
import { App } from './app';
import { WORLD_SIZES, WorldSize } from './sim/params';
import { Renderer } from './render/renderer';
import { Dock } from './ui/dock';
import { h, icon } from './ui/dom';
import { GodPanel, TOOL_DEFS } from './ui/godPanel';
import { Input } from './ui/input';
import { Inspector } from './ui/inspector';
import { Notifications } from './ui/notifications';
import { TopBar } from './ui/topbar';
import { TreeView } from './ui/treeView';

// Layout: a sidebar of tools on the left; on the right a header bar, the world, and the history dock.
const root = document.getElementById('app')!;
const canvas = document.getElementById('world') as HTMLCanvasElement;
const stage = h('main', { id: 'stage' });
stage.append(canvas);
const column = h('div', { id: 'main' });
root.append(column);

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
const size = params.get('size') as WorldSize | null;
const app = new App(renderer, seed, WORLD_SIZES[size && size in WORLD_SIZES ? size : 'wide'].width);

const toggleHelp = () => help.classList.toggle('hidden');
const notifications = new Notifications(app);
const helpBtn = h('button', { class: 'btn icon-btn help-btn', title: 'Help (?)', onclick: () => toggleHelp() }, '?');
const top = new TopBar(app, [notifications.button, helpBtn]);
const god = new GodPanel(app);
const inspector = new Inspector(app);
const tree = new TreeView(app);
const dock = new Dock(app, () => tree.open());
app.modules.push(top, god, inspector, dock, notifications, tree);
root.prepend(god.root);
column.append(top.root, stage, dock.root);
stage.append(inspector.root, notifications.panel);
root.append(tree.root);

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
      'The sea has tides, the sky has weather (clouds, rain, storms and lightning) and one shore rises into land. Tide-pool pioneers can colonise it if they evolve a waxy cuticle and roots; land plants then compete to grow tallest for the light. Given time, lineages can also become multicellular: a mutation can add a specialised cell (photocyte, mouth, eye, motor, shell, float or fat cell) to the body plan, and bodies grow cell by cell from a small bud. Open the tree of life (T) to watch species branch and die out.',
    ),
    h(
      'p',
      {},
      'Lineages with a sex drive court a mate when they are ready to breed (a rose-coloured pulse) and their young mix both parents\' genes; plants cross-pollinate on the wind. Brains with plastic synapses learn during their lives from reward, and cells can talk: two pheromones drift through the water, and what they come to mean (alarm, a mating call) is up to evolution.',
    ),
    h(
      'p',
      {},
      'You are god. Change the laws of nature, reshape the seabed, or strike with meteors, and watch life adapt. Click anything to inspect it, including a cell (and its brain and body plan), a rock, a vent, the water or the sky. Save your world to a file at any time. Bigger worlds are in the World panel.',
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
        ['H', 'Zoom out fully'],
        ['O', 'Cycle overlays'],
        ['T', 'Tree of life'],
        ['M', 'Minimise sidebar'],
        ['[ / ]', 'Brush size'],
        ['Esc', 'Deselect'],
        ...TOOL_DEFS.map((t) => [t.key.toUpperCase(), t.label]),
      ].map(([k, v]) => h('div', { class: 'key' }, h('kbd', {}, k), h('span', {}, v))),
    ),
    h('button', { class: 'btn primary wide', onclick: () => help.classList.add('hidden') }, 'Let there be life'),
  ),
);
root.append(help);
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
  renderer.resize(r.width, r.height, dpr);
  app.camera.setViewport(r.width, r.height);
}
new ResizeObserver(resize).observe(canvas);
resize();

// ---- main loop ------------------------------------------------------------------
const loading = h('div', { class: 'loading panel' }, h('span', { class: 'spinner' }), 'Creating a world…');
stage.append(loading);
let last = performance.now();
let frame = 0;
const brushTools = new Set(TOOL_DEFS.filter((t) => t.brush).map((t) => t.id));

function loop(now: number) {
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  app.fps = app.fps * 0.95 + (1 / dt) * 0.05;

  if (!app.ready) {
    app.simulate(dt);
    requestAnimationFrame(loop);
    return;
  }
  loading.remove();
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
