import type { Board, MeaningfulChange, Platform } from './types';

function platformEquals(a: Platform | null, b: Platform | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.state === b.state;
}

/**
 * Returns the meaningful changes between two boards of the same station (ADR-0002).
 * Meaningful: a cancellation, a platform change (number or provisional→confirmed),
 * or an expected-time swing of ≥ 5 minutes.
 */
export function diffBoards(previous: Board, current: Board): MeaningfulChange[] {
  const currentById = new Map(current.services.map((s) => [s.id, s]));
  const changes: MeaningfulChange[] = [];

  for (const prev of previous.services) {
    const curr = currentById.get(prev.id);
    if (!curr) continue;

    if (!prev.cancelled && curr.cancelled) {
      changes.push({ type: 'cancellation', serviceId: prev.id });
      continue;
    }

    if (!platformEquals(prev.platform, curr.platform)) {
      changes.push({
        type: 'platform-change',
        serviceId: prev.id,
        from: prev.platform,
        to: curr.platform,
      });
    }

    const swingMinutes =
      (Date.parse(curr.expectedTime) - Date.parse(prev.expectedTime)) / 60_000;
    if (Math.abs(swingMinutes) >= 5) {
      changes.push({ type: 'delay', serviceId: prev.id, minutesSwing: swingMinutes });
    }
  }

  return changes;
}
