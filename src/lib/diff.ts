import type { Board, MeaningfulChange, Platform } from './types';

/** Both a confirmed platform and one the train is currently at count as
 *  "confirmed", so a train merely arriving at (or leaving) an already-confirmed
 *  platform is not flagged as a platform change. */
function platformConfirmed(p: Platform): boolean {
  return p.state === 'confirmed' || p.state === 'at-platform';
}

function platformEquals(a: Platform | null, b: Platform | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && platformConfirmed(a) === platformConfirmed(b);
}

/**
 * Returns the meaningful changes between two boards of the same station (ADR-0002).
 * Meaningful: a cancellation, a platform change (number or provisional→confirmed;
 * a train arriving at / leaving an already-confirmed platform is not a change),
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

    // A service cancelled on either side contributes no further meaningful
    // changes: cancelled in both -> platform/time are irrelevant; reinstated
    // (prev cancelled, curr not) -> unspecified by ADR-0002, treated as no change.
    if (prev.cancelled || curr.cancelled) {
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
