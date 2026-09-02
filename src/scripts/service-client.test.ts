// Regression tests for the Calling Points header's "Next stop" line. The rule
// guarded here: the header's next stop MUST agree with the stop list below —
// a stop with no recorded actual is still to come (the card shows its
// "Expected" time), even when its SCHEDULED time has passed, because the
// train may be running late. It used to be judged on the scheduled time
// alone, so a delayed train short of Winchester reported Basingstoke as the
// next stop while the list still showed Winchester un-arrived.
// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { initServiceDetail, nextStop, stopCard, trainPosition } from './service-client';
import type { CallingPoint, ServiceDetail } from '../lib/types';

/** 2026-08-20 HH:MM UTC, sliced verbatim style like the app's naive ISO. */
const ISO = (h: number, m: number) => new Date(Date.UTC(2026, 7, 20, h, m)).toISOString();

function point(station: string, h: number, m: number, extra: Partial<CallingPoint> = {}): CallingPoint {
  return { station, scheduledTime: ISO(h, m), expectedTime: ISO(h, m), platform: null, cancelled: false, ...extra };
}

/** Salisbury 18:47 -> Grateley 18:59 -> Andover 19:06 -> Basingstoke 19:31. */
function service(extra: Partial<ServiceDetail> = {}): ServiceDetail {
  return {
    id: 'gb-nr:T12345:2026-08-20',
    origin: 'Salisbury',
    destination: 'Basingstoke',
    operator: 'South Western Railway',
    coaches: 5,
    cancelled: false,
    points: [
      point('Salisbury', 18, 47, { actualDeparture: ISO(18, 47) }),
      point('Grateley', 18, 59),
      point('Andover', 19, 6),
      point('Basingstoke', 19, 31),
    ],
    ...extra,
  };
}

afterEach(() => vi.useRealTimers());

// The station-codes loader (station-codes.ts) caches its fetch at module
// level, so the codes list must be served from the very first call: the
// disclosure test below searches from York and needs crsByStation populated.
beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ name: 'York', crs: 'YRK' }] })));
});

describe('stopCard', () => {
  it('shows "Arrived" for a stop the train has reached but not yet left (arrival actual, no departure yet)', () => {
    const html = stopCard(point('Basingstoke', 13, 50, { expectedTime: ISO(14, 2), actualArrival: ISO(14, 1), platform: { number: '4', state: 'at-platform' } }), false);
    expect(html).toContain('Arrived 14:01');
    expect(html).not.toContain('Expected');
    expect(html).not.toContain('Departed');
  });

  it('shows "Departed" once the train has left, arrival and departure both recorded', () => {
    const html = stopCard(point('Winchester', 13, 32, { actualArrival: ISO(13, 45), actualDeparture: ISO(13, 47) }), false);
    expect(html).toContain('Departed 13:47');
    expect(html).not.toContain('Arrived');
  });

  it('still shows "Completed" at the terminus', () => {
    const html = stopCard(point('Bournemouth', 12, 45, { actualArrival: ISO(12, 45) }), true);
    expect(html).toContain('Completed on time');
    expect(html).not.toContain('Arrived');
  });

  it('shows "Expected" while the train is still en route (no actuals)', () => {
    const html = stopCard(point('Reading', 14, 15, { expectedTime: ISO(14, 26) }), false);
    expect(html).toContain('Expected 14:26');
  });
});

describe('trainPosition', () => {
  it('rests at the origin while the train has not departed', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 18, 40));
    const d = service();
    const origin = d.points[0];
    if (origin) delete origin.actualDeparture;
    expect(trainPosition(d)).toEqual({ idx: 0, frac: null });
  });

  it('rests at a stop the train has arrived at but not left', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 2));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { actualArrival: ISO(18, 59) });
    expect(trainPosition(d)).toEqual({ idx: 1, frac: null });
  });

  it('slides between the last passed station and the next stop, clamped to the section', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 15));
    const d = service();
    // Origin departed 18:47, next stop Grateley expected 18:59 — the clock
    // (19:15) is well past the forecast, so the progress fraction clamps.
    expect(trainPosition(d)).toEqual({ idx: 1, frac: 0.92 });
  });

  it('interpolates part-way along a section the train is traversing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 18, 53)); // halfway 18:47 → 18:59
    const d = service();
    const r = trainPosition(d);
    expect(r.idx).toBe(1);
    expect(r.frac).toBeCloseTo(0.5, 1);
  });

  it('rests at the terminus once the journey is complete', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 40));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { actualArrival: ISO(18, 59), actualDeparture: ISO(19, 0) });
    d.points[2] = point('Andover', 19, 6, { actualArrival: ISO(19, 6), actualDeparture: ISO(19, 7) });
    d.points[3] = point('Basingstoke', 19, 31, { actualArrival: ISO(19, 31) });
    expect(trainPosition(d)).toEqual({ idx: 3, frac: null });
  });

  it('treats a past-due no-report origin as departed, not resting', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 0));
    const d = service();
    const origin = d.points[0];
    if (origin) {
      delete origin.actualDeparture;
      origin.noReport = true;
    }
    const r = trainPosition(d);
    expect(r.idx).toBe(1);
    expect(r.frac).toBe(0.92);
  });
});

describe('journey track render (mock pipeline)', () => {
  it('renders the decorative track + V, positioned, and keeps it aria-hidden', async () => {
    document.body.innerHTML = `
      <p id="svc-back"></p>
      <section id="svc-head"><h1 class="service-title">Service details</h1></section>
      <section id="service-detail" data-mock="true" data-api="https://example.test">
        <p class="as-of"><span id="as-of"></span><span id="stale-note" role="status"></span></p>
        <div id="svc-body"></div>
      </section>`;
    history.pushState({}, '', '/service/?id=gb-nr:T12345:2026-08-20');
    const root = document.getElementById('service-detail');
    if (!(root instanceof HTMLElement)) throw new Error('missing root');
    initServiceDetail(root);
    await new Promise((r) => setTimeout(r, 0)); // let the mock refresh settle

    const mainWrap = document.querySelector<HTMLElement>('.track-wrap.main');
    if (!mainWrap) throw new Error('no main track wrapper');
    // Decorative: silent to screen readers, which get the facts from the
    // header's "Next stop" line and the cards' own statuses.
    for (const sel of ['.track-done', '.track-todo', '.train-v']) {
      expect(mainWrap.querySelector(sel)?.getAttribute('aria-hidden')).toBe('true');
    }
    // Geometry applied: jsdom has no layout (all offsets 0), so the track's
    // ends meet the first/last rings exactly (top 0, no stub) and the split
    // clamps to the single ring position — the point is that the inline
    // positions were computed and written at all.
    const done = mainWrap.querySelector<HTMLElement>('.track-done')!;
    const todo = mainWrap.querySelector<HTMLElement>('.track-todo')!;
    const v = mainWrap.querySelector<HTMLElement>('.train-v')!;
    expect(done.style.top).toBe('0px');
    expect(parseFloat(todo.style.top)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(todo.style.top)).toBeLessThanOrEqual(16);
    expect(v.style.top).toBe(todo.style.top);
    expect(['visible', 'hidden']).toContain(v.style.visibility);
  });
});

describe('earlier calling points disclosure', () => {
  it('toggles the earlier list open/closed with the button (instant path in jsdom)', async () => {
    document.body.innerHTML = `
      <p id="svc-back"></p>
      <section id="svc-head"><h1 class="service-title">Service details</h1></section>
      <section id="service-detail" data-mock="true" data-api="https://example.test">
        <p class="as-of"><span id="as-of"></span><span id="stale-note" role="status"></span></p>
        <div id="svc-body"></div>
      </section>`;
    // Searched from York (mock route: KGX -> PBO -> York -> Newcastle ->
    // Edinburgh), so the stops before York form the earlier list. (The
    // codes list itself is stubbed file-wide in beforeAll.)
    history.pushState({}, '', '/service/?id=gb-nr:T12345:2026-08-20&from=YRK');
    const root = document.getElementById('service-detail');
    if (!(root instanceof HTMLElement)) throw new Error('missing root');
    initServiceDetail(root);
    // Let the mock refresh settle, then the codes fetch + re-render.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const btn = document.querySelector<HTMLButtonElement>('#earlier-btn');
    const wrap = document.querySelector<HTMLElement>('.track-wrap.earlier');
    const list = document.getElementById('earlier-stops');
    if (!btn || !wrap || !list) throw new Error('earlier disclosure missing');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(wrap.hidden).toBe(true); // the wrapper hides the collapsed list
    expect(wrap.querySelectorAll('.stop-item').length).toBe(2); // KGX + PBO before York

    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(btn.textContent).toBe('Hide earlier calling points');
    expect(wrap.hidden).toBe(false);
    expect(list.hidden).toBe(false);
    // No leftover animation styles in the instant path.
    expect(wrap.classList.contains('earlier-anim')).toBe(false);
    expect(list.classList.contains('open')).toBe(false);
    expect(list.getAttribute('style')).toBeNull();

    btn.click();
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(btn.textContent).toBe('Show earlier calling points');
    expect(wrap.hidden).toBe(true);
    expect(list.hidden).toBe(true);
  });
});

describe('nextStop', () => {
  it('agrees with the stop list: a stop without an actual is the next stop even when its scheduled time has passed (late train)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 15));
    // Grateley scheduled 18:59 is past, but the train hasn't arrived (no
    // actuals) and its expected time is 19:40 — running late. The list shows
    // "Expected 19:40"; the header must say Grateley, not Basingstoke.
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { expectedTime: ISO(19, 40) });
    expect(nextStop(d)?.station).toBe('Grateley');
  });

  it('skips the origin while the train still sits there, showing the stop after it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 18, 40));
    const d = service();
    const origin = d.points[0];
    if (origin) delete origin.actualDeparture; // not yet departed
    expect(nextStop(d)?.station).toBe('Grateley');
  });

  it('skips stops with a recorded actual (passed, even if early)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 0));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { actualArrival: ISO(18, 57) }); // ran early
    expect(nextStop(d)?.station).toBe('Andover');
  });

  it('skips a stop the train is sitting at (arrived, not yet departed)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 2));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { actualArrival: ISO(18, 59) });
    expect(nextStop(d)?.station).toBe('Andover');
  });

  it('with no live report, mirrors the stop card: past scheduled = gone, future scheduled = next', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 0));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { noReport: true }); // scheduled past -> "Departed — no live data"
    d.points[2] = point('Andover', 19, 6, { noReport: true }); // scheduled future -> "Expected"
    expect(nextStop(d)?.station).toBe('Andover');
  });

  it('returns null once every stop has an actual (journey completed)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 7, 20, 19, 40));
    const d = service();
    d.points[1] = point('Grateley', 18, 59, { actualArrival: ISO(18, 59), actualDeparture: ISO(19, 0) });
    d.points[2] = point('Andover', 19, 6, { actualArrival: ISO(19, 6), actualDeparture: ISO(19, 7) });
    d.points[3] = point('Basingstoke', 19, 31, { actualArrival: ISO(19, 31) });
    expect(nextStop(d)).toBeNull();
  });
});
