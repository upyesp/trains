/**
 * DOM-swap helper shared by the three live pages (station board, calling
 * points, platform board). Two jobs, both about not disturbing keyboard and
 * screen-reader users on the 30s auto-refresh (WCAG 2.4.3 Focus Order):
 *
 *  1. Skip the replacement entirely when the generated HTML is unchanged —
 *     most refresh ticks change nothing, and even an identical wholesale
 *     innerHTML reset yanks a screen reader's virtual reading position.
 *  2. When the content DID change and focus sat inside the container, restore
 *     it after the swap: to the same row (matched by [data-id] — the service
 *     id on boards, the station name on calling points), else the row at the
 *     previous index. Without this, document.activeElement falls back to
 *     <body> every 30 seconds while the user is reading the board.
 */

/** Replace `container`'s contents with `html`, preserving focus as above. */
export function renderKeepingFocus(container: HTMLElement, html: string): void {
  // The HTML serializer canonicalises bare '&' in attribute values to '&amp;'
  // (e.g. href="/service/?id=S1&from=RDG"). Re-reads of innerHTML therefore
  // never match a freshly generated string unless we generate the canonical
  // form too. esc() only ever emits these five entities, so the negative
  // lookahead can't double-escape existing ones.
  html = html.replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, '&amp;');
  // Unchanged tick: leave the DOM (and everyone's place in it) alone.
  if (container.innerHTML === html) return;

  const restore = captureFocus(container, document.activeElement);
  container.innerHTML = html;
  restore();
}

/** Build the post-swap focus restoration for the currently focused element,
 *  or a no-op when focus lies outside `container` (the common case). */
function captureFocus(container: HTMLElement, active: Element | null): () => void {
  if (!(active instanceof HTMLElement) || !container.contains(active)) return () => {};

  const row = active.closest<HTMLElement>('[data-id]');
  const key = row?.getAttribute('data-id') ?? null;
  const index = row ? Array.prototype.indexOf.call(container.children, row) : -1;

  return () => {
    let target: HTMLElement | null = null;
    if (key !== null) {
      target = container.querySelector<HTMLElement>(`[data-id="${CSS.escape(key)}"]`);
    }
    if (!target && index >= 0 && container.children.length > 0) {
      // The focused row vanished (train departed, list closed up): the row
      // that TOOK its place is the natural successor — clamped to the last
      // row when the removed one was at the end.
      const clamped = Math.min(index, container.children.length - 1);
      target = (container.children[clamped] as HTMLElement) ?? null;
    }
    if (!target) return;
    focusDeep(target);
  };
}

/** Focus `el` itself when it is interactive, else its first interactive
 *  descendant (the station-name link, platform link, or button in the row). */
function focusDeep(el: HTMLElement): void {
  if (
    el.matches('a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
  ) {
    el.focus();
    return;
  }
  el.querySelector<HTMLElement>(
    'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
  )?.focus();
}
