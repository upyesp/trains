import type { Board, BoardKind, Platform, Service } from './types';
import type { RTTLocationResponse, RTTPlannedActual, RTTService } from './rtt';

/**
 * Map an RTT `/gb-nr/location` response to our `Board`. Pure; no IO.
 *
 * Direction (departures/arrivals) is a *presentation* choice — RTT returns every
 * service at the location with both arrival and departure times (see
 * docs/research/rtt-api.md §4). A service appears on the board iff it has an
 * advertised time in that direction, so through-services (PASS) and services
 * that only start/terminate here drop out of the board they don't belong on.
 * Cancellations are kept (the UI demotes them).
 */
export function mapLocationLineUp(
  response: RTTLocationResponse,
  station: string,
  kind: BoardKind,
): Board {
  const services = (response.services ?? [])
    .map((s) => mapService(s, kind))
    .filter((s): s is Service => s !== null)
    .sort((a, b) => Date.parse(a.scheduledTime) - Date.parse(b.scheduledTime));

  return { station, kind, services };
}

function mapService(service: RTTService, kind: BoardKind): Service | null {
  const temporal =
    kind === 'departures' ? service.temporalData.departure : service.temporalData.arrival;

  // No advertised time in this direction -> not a public stop here (e.g. a
  // through-service on departures, or an originating service on arrivals).
  if (!temporal?.scheduleAdvertised) return null;

  const scheduledTime = temporal.scheduleAdvertised;
  // Expected = live forecast, else RTT estimate (entitlement-gated), else schedule ("on time").
  const expectedTime = temporal.realtimeForecast ?? temporal.realtimeEstimate ?? scheduledTime;

  return {
    id: service.scheduleMetadata.uniqueIdentity,
    scheduledTime,
    expectedTime,
    platform: platformFrom(service.locationMetadata?.platform),
    destination: otherEnd(service, kind),
    operator: service.scheduleMetadata.operator.name,
    coaches: coachesFrom(service.locationMetadata?.numberOfVehicles),
    cancelled: service.temporalData.displayAs === 'CANCELLED',
  };
}

/** Confirmed when `actual` is set; else provisional from `planned`; else unknown. */
function platformFrom(platform: RTTPlannedActual | undefined): Platform | null {
  if (!platform) return null;
  if (platform.actual) return { number: platform.actual, state: 'confirmed' };
  if (platform.planned) return { number: platform.planned, state: 'provisional' };
  return null;
}

/** Passenger-vehicle (coach) count. Absent or <=0 means unknown -> null. */
function coachesFrom(n: number | undefined): number | null {
  return n && n > 0 ? n : null;
}

/** Departures show the final destination; arrivals show the origin (the "other end"). */
function otherEnd(service: RTTService, kind: BoardKind): string {
  const pairs = kind === 'departures' ? service.destination : service.origin;
  const end = pairs[pairs.length - 1];
  return end?.location.description ?? '';
}
