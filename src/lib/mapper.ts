import type { Board, BoardKind, CallingPoint, Platform, Service, ServiceDetail } from './types';
import type {
  RTTLocationDisplayAs,
  RTTLocationPair,
  RTTLocationResponse,
  RTTPlannedActual,
  RTTService,
  RTTServiceDetailResponse,
  RTTServiceLocationItem,
  RTTTemporalData,
} from './rtt';

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
    platform: platformFrom(service.locationMetadata?.platform, service.temporalData?.status === 'AT_PLATFORM'),
    destination: otherEnd(service, kind),
    operator: service.scheduleMetadata.operator.name,
    coaches: coachesFrom(service.locationMetadata?.numberOfVehicles),
    cancelled: service.temporalData.displayAs === 'CANCELLED',
  };
}

/** At-platform (train stopped here now) > confirmed (`actual` set) > provisional
 *  (only `planned`). The at-platform flag comes from the location's live RTT
 *  status and overrides the rest — if the train is there, the platform is known. */
function platformFrom(platform: RTTPlannedActual | undefined, atPlatform = false): Platform | null {
  if (!platform) return null;
  const number = platform.actual ?? platform.planned;
  if (!number) return null;
  if (atPlatform) return { number, state: 'at-platform' };
  if (platform.actual) return { number, state: 'confirmed' };
  return { number, state: 'provisional' };
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

/** displayAs values that are advertised public stops (shown on the detail page). */
const PUBLIC_STOPS: ReadonlySet<RTTLocationDisplayAs> = new Set([
  'CALL',
  'STARTS',
  'TERMINATES',
  'CANCELLED',
]);

/** A stop counts if it has an advertised public `displayAs`. PASS (through, no
 * call), DIVERTED, and a missing value are not advertised stops. */
function isPublicStop(item: RTTServiceLocationItem): boolean {
  const d = item.temporalData?.displayAs;
  return d != null && PUBLIC_STOPS.has(d);
}

/** Pick the temporal element to show for a stop: arrival (most stops), else
 * departure (the origin only departs), else pass (defensive). Both scheduled and
 * expected times are read from the SAME element so the pair is direction-consistent
 * (an arrival delay against an arrival time, not a mismatched departure time). */
function temporalFor(item: RTTServiceLocationItem): RTTTemporalData | undefined {
  return item.temporalData?.arrival ?? item.temporalData?.departure ?? item.temporalData?.pass;
}

function callingPointFrom(item: RTTServiceLocationItem): CallingPoint {
  const t = temporalFor(item);
  const scheduledTime = t?.scheduleAdvertised ?? '';
  const expectedTime = t
    ? (t.realtimeForecast ?? t.realtimeEstimate ?? scheduledTime)
    : scheduledTime;
  return {
    station: item.location?.description ?? '',
    scheduledTime,
    expectedTime,
    platform: platformFrom(item.locationMetadata?.platform, item.temporalData?.status === 'AT_PLATFORM'),
    cancelled: item.temporalData?.displayAs === 'CANCELLED',
  };
}

/** The "other end" name from an origin/destination pair array (RTT may list
 * several; the last is the advertised end). */
function endpointName(pairs: RTTLocationPair[] | undefined): string {
  return pairs?.[pairs.length - 1]?.location.description ?? '';
}

/**
 * Map an RTT `/gb-nr/service` response to our `ServiceDetail`. Pure; no IO.
 *
 * Only advertised public stops are kept (CALL/STARTS/TERMINATES/CANCELLED);
 * through-services (PASS) and diversions drop out. Each stop's time prefers the
 * advertised arrival, falling back to the departure (the origin) so the run's
 * first stop still has a time. The `serviceId` is the id the request was opened
 * with (the Worker knows it); it is echoed back as `detail.id`.
 */
export function mapServiceDetail(
  response: RTTServiceDetailResponse,
  serviceId: string,
): ServiceDetail {
  const svc = response.service;
  const items = (svc?.locations ?? []).filter(isPublicStop);
  const points = items.map(callingPointFrom);

  // numberOfVehicles is a service-wide property repeated on each location; take
  // it from the first location that actually carries a positive count.
  const coachesItem = items.find(
    (i) => coachesFrom(i.locationMetadata?.numberOfVehicles) !== null,
  );

  return {
    id: serviceId,
    origin: endpointName(svc?.origin) || points[0]?.station || '',
    destination: endpointName(svc?.destination) || points[points.length - 1]?.station || '',
    operator: svc?.scheduleMetadata.operator.name ?? '',
    coaches: coachesFrom(coachesItem?.locationMetadata?.numberOfVehicles),
    cancelled: points.some((p) => p.cancelled),
    points,
  };
}
