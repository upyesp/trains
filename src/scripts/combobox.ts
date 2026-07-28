// WAI-ARIA combobox-with-listbox for station search. Imported by StationSearch.astro.
// On choose: deep-links to the station's pre-rendered shell (/stations/<crs>).

import type { Station } from '../data/stations';
import { searchStations, STATIONS } from '../data/stations';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

export function initCombobox(combo: HTMLElement): void {
  const inputEl = combo.querySelector<HTMLInputElement>('input[role="combobox"]');
  const listEl = combo.querySelector<HTMLUListElement>('.combo-list');
  if (!inputEl || !listEl) return;
  // Rebind to non-null consts: TS drops the post-guard narrowing inside the
  // closures below, so we carry the narrowed types via fresh bindings.
  const input = inputEl;
  const list = listEl;

  let matches: Station[] = [];
  let active = -1;

  function open(): void {
    combo.setAttribute('aria-expanded', 'true');
    list.hidden = false;
  }
  function close(): void {
    combo.setAttribute('aria-expanded', 'false');
    list.hidden = true;
    input.setAttribute('aria-activedescendant', '');
    active = -1;
  }

  function paint(): void {
    matches = searchStations(input.value, 100);
    if (matches.length === 0) {
      list.innerHTML = `<li class="empty" role="status">No stations match “${esc(input.value)}”.</li>`;
      input.setAttribute('aria-activedescendant', '');
      active = -1;
      return;
    }
    if (active >= matches.length) active = -1;
    list.innerHTML = matches
      .map(
        (s, i) =>
          `<li id="opt-${i}" class="opt" role="option" aria-selected="${i === active}" data-i="${i}"><span>${esc(s.name)}</span><code>${esc(s.crs)}</code></li>`,
      )
      .join('');
    input.setAttribute('aria-activedescendant', active >= 0 ? `opt-${active}` : '');
  }

  function setActive(i: number): void {
    if (matches.length === 0) return;
    active = ((i % matches.length) + matches.length) % matches.length;
    const children = Array.from(list.children);
    for (let idx = 0; idx < children.length; idx++) {
      const li = children[idx];
      if (li instanceof HTMLElement) {
        li.setAttribute('aria-selected', idx === active ? 'true' : 'false');
      }
    }
    input.setAttribute('aria-activedescendant', `opt-${active}`);
    const el = list.children[active];
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }

  function choose(s: Station): void {
    window.location.href = `/stations/${s.crs.toLowerCase()}`;
  }

  input.addEventListener('input', () => {
    open();
    paint();
  });
  input.addEventListener('focus', () => {
    if (!input.value) {
      matches = STATIONS.slice(0, 12);
      open();
      paint();
    }
  });
  input.addEventListener('click', () => open());

  input.addEventListener('keydown', (e) => {
    if (list.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter')) {
      matches = searchStations(input.value, 100);
      open();
      paint();
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive(active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive(active - 1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(matches.length - 1);
        break;
      case 'Escape':
        close();
        break;
      case 'Enter': {
        const sel = active >= 0 ? matches[active] : undefined;
        if (sel) {
          e.preventDefault();
          choose(sel);
        }
        break;
      }
    }
  });

  list.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('.opt') : null;
    if (!target) return;
    const idx = Number((target as HTMLElement).dataset.i);
    const sel = matches[idx];
    if (sel) choose(sel);
  });

  document.addEventListener('focusin', (e) => {
    if (!(e.target instanceof Node) || !combo.contains(e.target)) close();
  });
}
