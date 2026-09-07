// WAI-ARIA combobox-with-listbox for station search.
//
// Two modes share one accessible listbox pattern:
//   - Home "change station" search (default): choosing a station deep-links to
//     its pre-rendered shell (/stations/<crs>).
//   - Board "calling at" filter (selectable): choosing a station keeps it in the
//     input as the active filter, restores it on blur/Escape, and is clearable
//     via an optional .combo-clear button. An initialCrs is resolved to a name
//     once the station list loads (so a URL ?callsAt=CLJ shows "Clapham Junction").
//
// The full (~2,600 station) list is NOT imported here — that would inline it
// into every page. Instead it is fetched once from /stations.json (generated
// from the ODbL source; see src/data/SOURCES.md) and cached in memory.

import type { Station } from '../lib/station-search';
import { searchStations } from '../lib/station-search';

export interface ComboboxOptions {
  /** Custom choose behaviour. Default: navigate to /stations/<crs>. */
  onChoose?: (station: Station) => void;
  /** Called when the selection is cleared (selectable mode only). */
  onClear?: () => void;
  /**
   * Selectable (filter) mode: the chosen station stays shown in the input, is
   * restored on blur/Escape, and a .combo-clear button (if present) clears it.
   * Default false — the home search navigates away on choose.
   */
  selectable?: boolean;
  /** CRS to resolve + preselect once the station list loads (selectable mode). */
  initialCrs?: string | null;
  /** Station NAME to prefill the input with and auto-choose once the list loads
   *  (arriving from a service's calling points via /?station=<name>). On an
   *  exact match it lists that station's departures; otherwise the dropdown
   *  opens with the closest matches for the user to pick. */
  initialName?: string | null;
  /** Committed station to show in the input (navigate mode): the board page's
   *  "change station" box prefills with the station being viewed and restores
   *  it on blur/Escape, mirroring the "calling at" filter's remembered pick. */
  initialStation?: { crs: string; name: string } | null;
}

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

/** Touch devices: the on-screen keyboard otherwise covers the dropdown. */
const isTouch = window.matchMedia?.('(pointer: coarse)').matches ?? false;

/** Height of the *visible* area (shrinks when the soft keyboard is up). */
function visibleViewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

export function initCombobox(combo: HTMLElement, opts: ComboboxOptions = {}): void {
  const inputEl = combo.querySelector<HTMLInputElement>('input[role="combobox"]');
  const listEl = combo.querySelector<HTMLUListElement>('.combo-list');
  if (!inputEl || !listEl) return;
  const input = inputEl;
  const list = listEl;
  const clearBtn = combo.querySelector<HTMLButtonElement>('.combo-clear');
  const selectable = opts.selectable === true;

  let data: Station[] | null = null;
  let loadPromise: Promise<Station[]> | null = null;
  let matches: Station[] = [];
  let active = -1;
  let selected: Station | null = null;
  let savedBodyMinHeight = '';
  let bodyRoomAdded = false;
  let statusEl: HTMLElement | null = null;
  /** The user's latest open/close intent. The station list loads async, so a
   *  paint() that runs when the fetch lands must respect it: re-open only if
   *  the field was left open (never pop the popup open after a blur). */
  let openWanted = false;

  /** The combobox's polite live region (created once, next to the widget):
      announces loading / no-match / error states. Kept OUTSIDE the listbox,
      whose only children may be options (WAI-ARIA listbox semantics). */
  function status(message: string): void {
    if (!statusEl) {
      statusEl = document.createElement('span');
      statusEl.className = 'visually-hidden';
      statusEl.setAttribute('role', 'status'); // implies aria-live=polite
      combo.insertAdjacentElement('afterend', statusEl);
    }
    statusEl.textContent = '';
    if (message) {
      // Clear-then-write on the next frame so a repeated message re-announces.
      requestAnimationFrame(() => {
        if (statusEl) statusEl.textContent = message;
      });
    }
  }

  /** Mobile: scroll so the input sits near the top of the visible area, leaving
   *  the soft keyboard room only below the dropdown that opens beneath it.
   *  On a page too short to scroll (e.g. the home search), grant the body
   *  temporary scroll room so the scroll actually takes; removed on close. */
  function pinInputToTop(): void {
    if (!isTouch) return;
    const delta = Math.round(input.getBoundingClientRect().top - 12);
    if (delta <= 1) return;
    const need = window.scrollY + window.innerHeight + delta + 16;
    if (document.documentElement.scrollHeight < need) {
      if (!bodyRoomAdded) {
        savedBodyMinHeight = document.body.style.minHeight;
        bodyRoomAdded = true;
      }
      document.body.style.minHeight = `${need}px`;
    }
    window.scrollBy(0, delta);
  }

  /** Mobile: keep the dropdown inside the visible (above-keyboard) area. */
  function clampListHeight(): void {
    if (!isTouch) return;
    const topMargin = 12; // matches pinInputToTop's target
    const bottomMargin = 12;
    const gap = 6; // .combo-list { top: calc(100% + 6px) }
    const room = visibleViewportHeight() - (topMargin + input.offsetHeight + gap) - bottomMargin;
    list.style.maxHeight = `${Math.max(120, Math.min(320, room))}px`;
  }

  function navigate(st: Station): void {
    window.location.href = `${siteBase()}/stations/${st.crs.toLowerCase()}`;
  }

  /** Reflect the committed selection into the input (+ clear button in filter
   *  mode). Also runs for the board's change-station box, whose committed
   *  value is the station being viewed. */
  function applySelected(): void {
    if (!selected) {
      if (selectable) {
        input.value = '';
        if (clearBtn) clearBtn.hidden = true;
      }
      return;
    }
    input.value = selected.name;
    if (clearBtn) clearBtn.hidden = !selected;
  }

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
          // Resolve an initial selection from the URL ("calling at" filter).
          if (selectable && opts.initialCrs && !selected) {
            const needle = opts.initialCrs.toLowerCase();
            const found = data.find((s) => s.crs.toLowerCase() === needle);
            if (found) {
              selected = found;
              applySelected();
            }
          }
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
    openWanted = true;
    // aria-expanded belongs on the element with role=combobox (the input) —
    // that's what screen readers announce; the wrapper div carries no role.
    input.setAttribute('aria-expanded', 'true');
    list.hidden = false;
    clampListHeight();
  }
  function close(): void {
    openWanted = false;
    input.setAttribute('aria-expanded', 'false');
    list.hidden = true;
    list.style.maxHeight = ''; // restore the CSS default
    input.removeAttribute('aria-activedescendant');
    active = -1;
    if (bodyRoomAdded) {
      document.body.style.minHeight = savedBodyMinHeight;
      bodyRoomAdded = false;
      savedBodyMinHeight = '';
    }
  }

  function paint(): void {
    // Reset highlight on every render: predictable, and ArrowDown re-establishes it.
    active = -1;
    if (!data) {
      status('Loading stations…');
      // Keep the popup open (empty): the listbox may only contain options, so
      // while loading there is nothing to render — but the open box is the
      // visible "something happened", and options appear the moment data lands.
      return;
    }
    matches = searchStations(data, input.value, 100);
    if (matches.length === 0) {
      status(`No stations match “${input.value}”.`);
      close();
      return;
    }
    status('');
    // Option ids are namespaced by the listbox's own id: a station page runs
    // TWO comboboxes (change station + calling-at filter), and bare opt-N ids
    // would collide, breaking aria-activedescendant resolution.
    list.innerHTML = matches
      .map(
        (st, i) =>
          `<li id="${list.id}-opt-${i}" class="opt" role="option" aria-selected="false" data-i="${i}"><span>${esc(st.name)}</span><code>${esc(st.crs)}</code></li>`,
      )
      .join('');
    // No option is highlighted after a fresh render; aria-activedescendant
    // should be ABSENT (not empty) until ArrowDown picks one.
    input.removeAttribute('aria-activedescendant');
    // Re-open when the user left the field open: the typical race is focus
    // before stations.json resolves — open() ran, the loading paint left the
    // box open, and this paint fills it. Guarded by openWanted so a stale
    // async paint after blur can't reopen the popup uninvited.
    if (openWanted) open();
  }

  function openAndPaint(): void {
    open();
    if (data) {
      paint();
      return;
    }
    paint(); // announces "Loading stations…" via the status region
    ensureLoaded()
      .then(() => paint())
      .catch(() => {
        status('Couldn\u2019t load the station list.');
        close();
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
    input.setAttribute('aria-activedescendant', `${list.id}-opt-${active}`);
    const el = list.children[active];
    if (el instanceof HTMLElement) el.scrollIntoView({ block: 'nearest' });
  }

  function choose(st: Station): void {
    if (opts.onChoose) opts.onChoose(st);
    else navigate(st);
    if (selectable) {
      selected = st;
      applySelected();
      close();
    }
  }

  input.addEventListener('input', openAndPaint);
  input.addEventListener('focus', () => {
    pinInputToTop();
    if (isTouch) requestAnimationFrame(pinInputToTop); // win the race with iOS's own scroll-into-view
    if (list.hidden) openAndPaint();
    // Select-all so typing a new query replaces the current pick.
    if (selected) input.select();
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
        if (list.hidden) openAndPaint();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        if (list.hidden) openAndPaint();
        setActive(matches.length - 1);
        break;
      case 'Escape':
        close();
        applySelected(); // abandon an un-committed query
        break;
      case 'Enter': {
        // No highlighted option yet (the common type-ahead flow: type
        // "Wat", press Enter) — choose the TOP match, not nothing.
        const sel = active >= 0 ? matches[active] : matches[0];
        if (sel) {
          e.preventDefault();
          choose(sel);
        }
        break;
      }
    }
  });

  // Keep focus in the input while the pointer presses an option (the APG
  // combobox pattern): without this, some browsers blur the input on tap and
  // the document-level close hides the listbox before the click event lands —
  // the click then hits a hidden list and the selection silently does nothing.
  list.addEventListener('mousedown', (e) => {
    if (e.target instanceof Element && e.target.closest('.opt')) {
      e.preventDefault();
    }
  });

  list.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target.closest('.opt') : null;
    if (!target) return;
    const idx = Number((target as HTMLElement).dataset.i);
    const sel = matches[idx];
    if (sel) choose(sel);
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selected = null;
      applySelected();
      opts.onClear?.();
      close();
      // Clearing is a committed action: collapse the listbox and drop focus so
      // the field "flattens" and the mobile keyboard dismisses, rather than
      // leaving the dropdown open awaiting a new query.
      (document.activeElement as HTMLElement | null)?.blur();
    });
  }

  document.addEventListener('focusin', (e) => {
    if (!(e.target instanceof Node) || !combo.contains(e.target)) {
      close();
      applySelected(); // restore the committed selection on blur
    }
  });

  // The soft keyboard animates in over a few frames, resizing the visual
  // viewport; re-clamp the dropdown so it always ends at the keyboard's edge.
  const vv = window.visualViewport;
  if (vv) {
    const onVv = (): void => {
      if (!list.hidden) clampListHeight();
    };
    vv.addEventListener('resize', onVv);
    vv.addEventListener('scroll', onVv);
  }

  // Preload + resolve an initial selection (filter mode restored from the URL).
  if (selectable && opts.initialCrs) {
    void ensureLoaded().catch(() => {});
  }

  // Prefill + commit the station being viewed (board's "change station" box):
  // shown in the input and restored on blur/Escape like the filter's pick.
  if (opts.initialStation) {
    selected = {
      crs: opts.initialStation.crs,
      name: opts.initialStation.name,
      country: '',
      lat: null,
      long: null,
    };
    applySelected();
  }

  // Prefill + auto-choose from a station name (arriving from calling points).
  // Shows the name immediately; once the list loads, an exact match is chosen
  // (navigates to that station's departures), else the dropdown opens to pick.
  if (opts.initialName) {
    input.value = opts.initialName;
    void ensureLoaded()
      .then((list) => {
        const needle = (opts.initialName ?? '').trim().toLowerCase();
        const exact = list.find((s) => s.name.toLowerCase() === needle);
        if (exact) choose(exact);
        else openAndPaint();
      })
      .catch(() => {
        /* leave the prefilled name; the user can retry */
      });
  }
}
