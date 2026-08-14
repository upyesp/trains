// Regression tests for the station combobox's open/close flow. The essential
// behaviour guarded here: after the user opens the field, the option list MUST
// become visible once the station list finishes loading — the dropdown used to
// be left hidden by the loading paint (the options rendered into a hidden
// listbox), which made station selection appear completely dead.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initCombobox } from './combobox';

interface Station {
  crs: string;
  name: string;
  country: string;
  lat: number | null;
  long: number | null;
}

const STATIONS: Station[] = [
  { crs: 'LDS', name: 'Leeds', country: 'England', lat: null, long: null },
  { crs: 'LBG', name: 'London Bridge', country: 'England', lat: null, long: null },
  { crs: 'KGX', name: 'London Kings Cross', country: 'England', lat: null, long: null },
];

function makeCombo(): { combo: HTMLElement; input: HTMLInputElement; list: HTMLUListElement } {
  document.body.innerHTML = `
    <div class="combo" id="combo">
      <input id="station-input" type="text" role="combobox" aria-expanded="false"
        aria-haspopup="listbox" aria-controls="station-list" aria-autocomplete="list"
        aria-activedescendant="" />
      <ul id="station-list" class="combo-list" role="listbox" aria-label="Stations" hidden></ul>
    </div>`;
  return {
    combo: document.getElementById('combo') as HTMLElement,
    input: document.getElementById('station-input') as HTMLInputElement,
    list: document.getElementById('station-list') as HTMLUListElement,
  };
}

/** A fetch that stays pending until the test resolves it. */
function pendingFetch(): { mock: ReturnType<typeof vi.fn>; resolve: (stations: Station[]) => void } {
  let resolveJson!: (stations: Station[]) => void;
  const mock = vi.fn(
    () =>
      new Promise((r) => {
        resolveJson = (stations: Station[]) =>
          r({ ok: true, json: () => Promise.resolve(stations) });
      }),
  );
  // Read the variable at call time: it is only assigned once the combobox
  // actually calls fetch.
  return { mock, resolve: (stations) => resolveJson(stations) };
}

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom lacks matchMedia and requestAnimationFrame; the combobox probes both.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as unknown as typeof window.requestAnimationFrame;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('combobox open/close flow', () => {
  it('opens and shows options once the station list loads (focus happens before the fetch lands)', async () => {
    const { combo, input, list } = makeCombo();
    const { mock, resolve } = pendingFetch();
    vi.stubGlobal('fetch', mock);
    initCombobox(combo, {});

    input.focus();
    // While the fetch is in flight the box stays open (empty) — visible feedback.
    expect(list.hidden).toBe(false);
    expect(list.children.length).toBe(0);

    resolve(STATIONS);
    await vi.waitFor(() => expect(list.children.length).toBe(3));

    expect(list.hidden).toBe(false);
    expect(list.querySelector('#station-list-opt-0')?.textContent).toContain('Leeds');
    expect(input.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not reopen the popup when the load lands after the user has moved on', async () => {
    const { combo, input, list } = makeCombo();
    const { mock, resolve } = pendingFetch();
    vi.stubGlobal('fetch', mock);
    initCombobox(combo, {});

    input.focus();
    expect(list.hidden).toBe(false);

    // The user leaves the field: the document-level focusin close fires.
    document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(list.hidden).toBe(true);

    resolve(STATIONS);
    await vi.waitFor(() => expect(list.children.length).toBe(3));

    // Options render but the popup must NOT pop open uninvited.
    expect(list.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes and announces when nothing matches', async () => {
    const { combo, input, list } = makeCombo();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(STATIONS) })));
    initCombobox(combo, {});

    // Focus loads the data with the empty query (options render open).
    input.focus();
    await vi.waitFor(() => expect(list.children.length).toBe(3));
    expect(list.hidden).toBe(false);

    // A query with no matches closes the popup (announced via the status region).
    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(list.hidden).toBe(true);
    expect(input.getAttribute('aria-expanded')).toBe('false');
    void combo;
  });
});
