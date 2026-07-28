// WAI-ARIA combobox-with-listbox for station search.
//
// The full (~2,600 station) list is NOT imported here — that would inline it
// into every page. Instead it is fetched once from /stations.json (generated
// from the ODbL source; see src/data/SOURCES.md) and cached in memory. On
// choose: deep-link to the station's pre-rendered shell (/stations/<crs>).

import type { Station } from '../lib/station-search';
import { searchStations } from '../lib/station-search';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

function siteBase(): string {
  // Astro replaces import.meta.env.BASE_URL with the configured base ("/" here).
  return (import.meta.env.BASE_URL || '/').replace(/\/$/, '');
}

export function initCombobox(combo: HTMLElement): void {
  const inputEl = combo.querySelector<HTMLInputElement>('input[role="combobox"]');
  const listEl = combo.querySelector<HTMLUListElement>('.combo-list');
  if (!inputEl || !listEl) return;
  const input = inputEl;
  const list = listEl;

  let data: Station[] | null = null;
  let loadPromise: Promise<Station[]> | null = null;
  let matches: Station[] = [];
  let active = -1;

  function ensureLoaded(): Promise<Station[]> {
    if (data) return Promise.resolve(data);
    if (!loadPromise) {
      loadPromise = fetch(`${siteBase()}/stations.json`, { cache: 'force-cache' })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<Station[]>;
        })
        .then((d) => {
          data = Array.isArray(d) ? d : [];
          return data;
        })
        .catch((e) => {
          loadPromise = null; // allow a retry on the next interaction
          throw e;
        });
    }
    return loadPromise;
  }

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
    // Reset highlight on every render: predictable, and ArrowDown re-establishes it.
    active = -1;
    if (!data) {
      list.innerHTML = `<li class="empty" role="status">Loading stations…</li>`;
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    matches = searchStations(data, input.value, 100);
    if (matches.length === 0) {
      list.innerHTML = `<li class="empty" role="status">No stations match “${esc(input.value)}”.</li>`;
      input.setAttribute('aria-activedescendant', '');
      return;
    }
    list.innerHTML = matches
      .map(
        (st, i) =>
          `<li id="opt-${i}" class="opt" role="option" aria-selected="false" data-i="${i}"><span>${esc(st.name)}</span><code>${esc(st.crs)}</code></li>`,
      )
      .join('');
    input.setAttribute('aria-activedescendant', '');
  }

  function openAndPaint(): void {
    open();
    if (data) {
      paint();
      return;
    }
    paint(); // shows the loading row
    ensureLoaded()
      .then(() => paint())
      .catch(() => {
        list.innerHTML = `<li class="empty" role="alert">Couldn\u2019t load the station list.</li>`;
        input.setAttribute('aria-activedescendant', '');
      });
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

  function choose(st: Station): void {
    window.location.href = `${siteBase()}/stations/${st.crs.toLowerCase()}`;
  }

  input.addEventListener('input', openAndPaint);
  input.addEventListener('focus', () => {
    if (list.hidden) openAndPaint();
  });
  input.addEventListener('click', openAndPaint);

  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (list.hidden || matches.length === 0) openAndPaint();
        else setActive(active + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!list.hidden && matches.length > 0) setActive(active - 1);
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
