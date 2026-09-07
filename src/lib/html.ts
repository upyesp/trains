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
 *
 * When `href` is given the NUMBER becomes a link to that platform's board page
 * (underlined like the other links on the site); the number is the only
 * clickable part of the chip.
 */
export function platformChip(p: Platform | null, href?: string): string {
  const label = '<span class="plat-label" aria-hidden="true">Platform</span>';
  if (!p) return `<span class="plat none" aria-hidden="true">${label}—</span>`;
  const n = esc(p.number);

  // The status is spoken right after the number, BEFORE any link hint, so
  // screen readers hear "Platform 3, confirmed" and only then what the link
  // does — never "3, view this platform's departures…, confirmed".
  const stateCls = p.state === 'at-platform' ? ' at-platform' : p.state === 'provisional' ? ' provisional' : '';
  const spoken =
    p.state === 'at-platform' ? ', at platform' : p.state === 'provisional' ? ', provisional' : ', confirmed';

  if (href) {
    // The visible status caption stays outside the link (identical look); the
    // link's accessible name carries the status before the hint, and the
    // caption is aria-hidden there so the status isn't spoken twice.
    const visibleState =
      p.state === 'at-platform'
        ? '<span class="state" aria-hidden="true">At platform</span>'
        : p.state === 'provisional'
          ? '<span class="state" aria-hidden="true">provisional</span>'
          : '';
    return `<span class="plat${stateCls}">${label}<a class="plat-link" href="${href}">${n}<span class="visually-hidden">${spoken} — view this platform's departures and arrivals</span></a>${visibleState}</span>`;
  }
  // No link: the caption itself is the spoken status, already right after the number.
  if (p.state === 'at-platform') {
    return `<span class="plat at-platform">${label}${n}<span class="state">At platform</span></span>`;
  }
  if (p.state === 'provisional') {
    return `<span class="plat provisional">${label}${n}<span class="state">provisional</span></span>`;
  }
  return `<span class="plat">${label}${n}<span class="visually-hidden">, confirmed</span></span>`;
}
