// Small, pure HTML helpers shared by the station-board and service-detail
// clients. Both render the platform the same way (a bordered .plat chip), so the
// chip builder lives here to keep them in lockstep rather than drifting apart.

import type { Platform } from './types';

const ESC: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape a string for safe interpolation into HTML. */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
}

/**
 * The bordered platform chip shared by the station board and the service-detail
 * calling-points list. A visible "Platform" caption sits inside the box, stacked
 * above the number and centred (.plat is a centred column flex). The caption is
 * mobile-only on the board (.plat-label is hidden on desktop, which has a column
 * header); the detail page shows it at every breakpoint via `.stops .plat-label`.
 *
 * The caption is aria-hidden: screen readers instead hear the cell's
 * visually-hidden "Platform:" label (see platformCell in each client), so a stop
 * reads as "Platform: 4, confirmed".
 */
export function platformChip(p: Platform | null): string {
  const label = '<span class="plat-label" aria-hidden="true">Platform</span>';
  if (!p) return `<span class="plat none" aria-hidden="true">${label}—</span>`;
  const n = esc(p.number);
  if (p.state === 'at-platform') {
    // Visible caption (also spoken) — the train is at this platform right now.
    return `<span class="plat at-platform">${label}${n}<span class="state">At platform</span></span>`;
  }
  if (p.state === 'provisional') {
    return `<span class="plat provisional">${label}${n}<span class="state">provisional</span></span>`;
  }
  return `<span class="plat">${label}${n}<span class="visually-hidden">, confirmed</span></span>`;
}
