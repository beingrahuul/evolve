import { Bell, Dna, Info, Skull, Trash2, X, Zap } from 'lucide';
import { App, AppModule } from '../app';
import { DT } from '../sim/params';
import type { EventKind, WorldEvent } from '../sim/world';
import { h, icon } from './dom';

const ICONS: Record<EventKind, Parameters<typeof icon>[0]> = {
  species: Dna,
  extinct: Skull,
  god: Zap,
  info: Info,
};

const FILTERS: [EventKind | 'all', string][] = [
  ['all', 'All'],
  ['species', 'Life'],
  ['extinct', 'Extinctions'],
  ['god', 'Acts of god'],
  ['info', 'World'],
];

/** Keep at most this many notifications per world. */
const KEEP = 1000;

/**
 * The notification centre: every world event (new species, extinctions, acts of god, weather)
 * is kept in a list behind the bell in the top bar, instead of popping up over the world.
 */
export class Notifications implements AppModule {
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  private badge = h('span', { class: 'bell-badge hidden' });
  private list = h('div', { class: 'notif-list' });
  private chips = new Map<EventKind | 'all', HTMLButtonElement>();
  private items: WorldEvent[] = [];
  private lastSeq = 0;
  private unread = 0;
  private filter: EventKind | 'all' = 'all';

  constructor(private app: App) {
    this.button = h(
      'button',
      { class: 'btn icon-btn bell', title: 'Notifications', onclick: () => this.toggle() },
      icon(Bell, 15),
      this.badge,
    );
    const chips = h('div', { class: 'chips' });
    for (const [k, label] of FILTERS) {
      const b = h('button', { class: 'chip', onclick: () => this.setFilter(k) }, label);
      this.chips.set(k, b);
      chips.append(b);
    }
    this.panel = h(
      'section',
      { id: 'notifications', class: 'panel hidden' },
      h(
        'div',
        { class: 'notif-head' },
        h('span', { class: 'notif-title' }, 'Notifications'),
        h('button', { class: 'btn icon-btn', title: 'Clear all', onclick: () => this.clear() }, icon(Trash2, 14)),
        h('button', { class: 'btn icon-btn', title: 'Close', onclick: () => this.close() }, icon(X, 14)),
      ),
      chips,
      this.list,
    );
    // close when clicking elsewhere
    document.addEventListener('pointerdown', (e) => {
      const t = e.target as Node;
      if (this.isOpen && !this.panel.contains(t) && !this.button.contains(t)) this.close();
    });
    this.setFilter('all');
  }

  get isOpen() {
    return !this.panel.classList.contains('hidden');
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    this.panel.classList.remove('hidden');
    this.button.classList.add('active');
    this.unread = 0;
    this.renderBadge();
    this.renderList();
  }

  close() {
    this.panel.classList.add('hidden');
    this.button.classList.remove('active');
  }

  private setFilter(f: EventKind | 'all') {
    this.filter = f;
    for (const [k, b] of this.chips) b.classList.toggle('active', k === f);
    this.renderList();
  }

  private clear() {
    this.items = [];
    this.unread = 0;
    this.renderBadge();
    this.renderList();
  }

  onWorldChanged() {
    // a new or loaded world brings its own history: show it, all read
    this.items = [];
    this.lastSeq = 0;
    this.pull();
    this.unread = 0;
    this.renderBadge();
    this.renderList();
  }

  update(frame: number) {
    if (frame % 10 !== 0) return;
    const added = this.pull();
    if (!added) return;
    if (this.isOpen) this.renderList();
    else {
      this.unread += added;
      this.renderBadge();
      this.button.classList.remove('ping');
      void this.button.offsetWidth; // restart the animation
      this.button.classList.add('ping');
    }
  }

  /** Take new events from the world; returns how many arrived. */
  private pull(): number {
    let n = 0;
    for (const e of this.app.world.events) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      this.items.push(e);
      n++;
    }
    if (this.items.length > KEEP) this.items.splice(0, this.items.length - KEEP);
    return n;
  }

  private renderBadge() {
    this.badge.textContent = this.unread > 99 ? '99+' : String(this.unread);
    this.badge.classList.toggle('hidden', this.unread === 0);
  }

  private when(tick: number): string {
    // the world starts at 07:12 on day 1
    const d = 0.3 + (tick * DT) / this.app.world.params.dayLength;
    const hr = (d % 1) * 24;
    return `Day ${Math.floor(d) + 1} · ${String(Math.floor(hr)).padStart(2, '0')}:${String(Math.floor((hr % 1) * 60)).padStart(2, '0')}`;
  }

  private renderList() {
    if (!this.isOpen) return;
    const shown = this.items.filter((e) => this.filter === 'all' || e.kind === this.filter);
    const rows: HTMLElement[] = [];
    for (let i = shown.length - 1; i >= 0; i--) {
      const e = shown[i];
      rows.push(
        h(
          'div',
          { class: `notif ${e.kind}` },
          icon(ICONS[e.kind], 15),
          h('div', { class: 'notif-body' }, h('div', {}, e.text), h('div', { class: 'notif-time' }, this.when(e.tick))),
        ),
      );
    }
    if (!rows.length) rows.push(h('div', { class: 'notif-empty' }, 'Nothing yet. News of the world will collect here.'));
    this.list.replaceChildren(...rows);
  }
}
