import { createElement } from 'lucide';

type IconNode = Parameters<typeof createElement>[0];
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === 'html') el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

export function icon(node: IconNode, size = 16): SVGElement {
  const el = createElement(node);
  el.setAttribute('width', String(size));
  el.setAttribute('height', String(size));
  el.setAttribute('stroke-width', '1.8');
  el.classList.add('icon');
  return el;
}

export function fmt(x: number, digits = 1): string {
  if (!isFinite(x)) return '—';
  const a = Math.abs(x);
  if (a >= 10000) return (x / 1000).toFixed(0) + 'k';
  if (a >= 1000) return (x / 1000).toFixed(1) + 'k';
  return x.toFixed(digits);
}

export function pct(x: number, digits = 0): string {
  return (x * 100).toFixed(digits) + '%';
}

/** A labelled horizontal bar whose fill and value are updated in place. */
export function bar(label: string, color: string) {
  const fill = h('div', { class: 'bar-fill', style: { background: color } });
  const value = h('span', { class: 'bar-value' });
  const root = h(
    'div',
    { class: 'bar-row' },
    h('span', { class: 'bar-label' }, label),
    h('div', { class: 'bar-track' }, fill),
    value,
  );
  return {
    root,
    set(frac: number, text: string) {
      fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      value.textContent = text;
    },
  };
}

/** Key/value grid whose values update in place. */
export function kvGrid(keys: string[]) {
  const vals: Record<string, HTMLElement> = {};
  const root = h('div', { class: 'kv' });
  for (const k of keys) {
    const v = h('span', { class: 'kv-v' }, '—');
    vals[k] = v;
    root.append(h('span', { class: 'kv-k' }, k), v);
  }
  return {
    root,
    set(k: string, text: string) {
      const el = vals[k];
      if (el && el.textContent !== text) el.textContent = text;
    },
  };
}

export function section(title: string, ...children: (Child | Child[])[]) {
  return h('div', { class: 'section' }, h('div', { class: 'section-title' }, title), ...children);
}
