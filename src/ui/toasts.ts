import { Dna, Info, Skull, Zap } from 'lucide';
import { App, AppModule } from '../app';
import { EventKind } from '../sim/world';
import { h, icon } from './dom';

const ICONS: Record<EventKind, Parameters<typeof icon>[0]> = {
  species: Dna,
  extinct: Skull,
  god: Zap,
  info: Info,
};

/** Shows world events (speciation, extinctions, acts of god) as fading notifications. */
export class Toasts implements AppModule {
  readonly root = h('div', { id: 'toasts' });
  private lastSeq = 0;

  constructor(private app: App) {}

  onWorldChanged() {
    this.root.replaceChildren();
    // only announce the newest event (e.g. "world created" / "world restored"), not a loaded world's history
    const evs = this.app.world.events;
    this.lastSeq = evs.length ? evs[evs.length - 1].seq - 1 : 0;
  }

  update(frame: number) {
    if (frame % 10 !== 0) return;
    const evs = this.app.world.events;
    for (const e of evs) {
      if (e.seq <= this.lastSeq) continue;
      this.lastSeq = e.seq;
      const t = h('div', { class: `toast ${e.kind}` }, icon(ICONS[e.kind], 15), h('span', {}, e.text));
      this.root.prepend(t);
      while (this.root.children.length > 4) this.root.lastElementChild?.remove();
      setTimeout(() => t.classList.add('fade'), 7000);
      setTimeout(() => t.remove(), 7800);
    }
  }
}
