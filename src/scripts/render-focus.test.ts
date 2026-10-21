// Regression tests for render-focus.ts: the 30s auto-refresh must never
// destroy keyboard/screen-reader focus (WCAG 2.4.3), and an unchanged tick
// must not touch the DOM at all (screen-reader reading position).
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderKeepingFocus } from './render-focus';

const TWO_ROWS =
  '<li data-id="a"><a href="#">A</a></li><li data-id="b"><a href="#">B</a></li>';

describe('renderKeepingFocus', () => {
  beforeEach(() => {
    document.body.innerHTML = `<ul id="list">${TWO_ROWS}</ul>`;
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  function list(): HTMLElement {
    return document.getElementById('list') as HTMLElement;
  }

  it('skips the DOM swap entirely when the HTML is unchanged', () => {
    const row = list().querySelector('li')!;
    renderKeepingFocus(list(), list().innerHTML);
    expect(list().querySelector('li')).toBe(row); // same node — nothing replaced
  });

  it('treats serializer-canonicalised &amp; as unchanged across ticks', () => {
    // Generated hrefs contain bare '&' (query strings); innerHTML reads back
    // '&amp;'. The next identical tick must still be recognised as unchanged.
    document.body.innerHTML = '<ul id="list"></ul>';
    const el = document.getElementById('list') as HTMLElement;
    const row = '<li data-id="s1"><a href="/service/?id=s1&from=RDG">Leeds</a></li>';
    renderKeepingFocus(el, row);
    const node = el.querySelector('li')!;
    renderKeepingFocus(el, row); // identical generation on the next tick
    expect(el.querySelector('li')).toBe(node);
  });

  it('restores focus to the same [data-id] row after a content change', () => {
    const link = list().querySelector<HTMLElement>('li[data-id="b"] a')!;
    link.focus();
    expect(document.activeElement).toBe(link);

    renderKeepingFocus(
      list(),
      '<li data-id="a"><a href="#">A2</a></li><li data-id="b"><a href="#">B2</a></li>',
    );
    expect(document.activeElement).toBe(list().querySelector('li[data-id="b"] a'));
  });

  it('falls back to the previous row index when the focused row is gone', () => {
    const link = list().querySelector<HTMLElement>('li[data-id="b"] a')!;
    link.focus();

    // Row "b" vanished; the new row at index 1 should receive focus.
    renderKeepingFocus(list(), '<li data-id="a"><a href="#">A2</a></li>');
    expect(document.activeElement).toBe(list().querySelectorAll('a')[0]);
  });

  it('focuses the first interactive child of the restored row', () => {
    // Focus the row's inner div (made focusable via tabindex, as a screen
      // reader's virtual cursor position would be) — restoration should still
    // land on an interactive element inside the same row.
    document.body.innerHTML =
      '<ul id="list"><li data-id="b"><div class="wrap" tabindex="0"><a href="#">B</a></div></li></ul>';
    const wrap = document.querySelector<HTMLElement>('.wrap')!;
    wrap.focus();
    renderKeepingFocus(
      list(),
      '<li data-id="b"><div class="wrap"><a href="#">B2</a></div></li>',
    );
    expect(document.activeElement).toBe(list().querySelector('a'));
  });

  it('leaves focus alone when it sits outside the container', () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();

    renderKeepingFocus(list(), '<li data-id="c"><a href="#">C</a></li>');
    expect(document.activeElement).toBe(outside);
  });
});
