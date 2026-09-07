// Domain types for the trains site, derived from CONTEXT.md.
// Shared DTO contract between the Cloudflare Worker (proxy) and the Astro client.
// Pure domain shapes — no implementation details.

/** A platform assignment. Either provisional (planned) or confirmed (live, announced). */
export interface Platform {
  /** The platform number/letter as displayed, e.g. "3". */
  number: string;
  /** `provisional` = only the timetabled platform (`planned`); `confirmed` = the
   *  station has reported it (`actual`); `at-platform` = the train is stopped
   *  there right now (RTT status AT_PLATFORM — implies confirmed). */
  state: 'provisional' | 'confirmed' | 'at-platform';
}

/** A single scheduled train run — a departure from, or arrival at, a station. */
export interface Service {
  /** Stable identity across refreshes (RTT service id / train UID). Used to match previous↔current. */
  id: string;
  /** Scheduled departure/arrival time, ISO 8601. */
  scheduledTime: string;
  /** Expected (live predicted) departure/arrival time, ISO 8601. May differ from scheduledTime. */
  expectedTime: string;
  /** Recorded actual departure/arrival time, ISO 8601. Present once the train
   *  has passed this stop and TRUST reported it (RTT `realtimeActual`). The
   *  truth for past stops — preferred over `expectedTime` for display. */
  actualTime?: string;
  /** True when RTT has NO live report for this element (RTT `realtimeNoReport`).
   *  With no forecast, estimate, or actual either, the expected time is just the
   *  timetable — the UI must NOT present it as "on time" (the train may be
   *  running late unreported). */
  noReport?: boolean;
  /** Platform, or null when not yet announced. */
  platform: Platform | null;
  /** Final destination (departures) or origin (arrivals). */
  destination: string;
  /** The train's true starting station (RTT origin[0]) — shown on the boards
   *  page as the "from" of the total journey time. */
  origin: string;
  /** The train's true final destination (RTT destination[last]) — shown on
   *  the boards page as the "to" of the total journey time (on arrivals boards
   *  the row's main label is the origin; this is the far end). */
  finalDestination: string;
  /** The Train Operating Company running this service. */
  operator: string;
  /** Number of passenger vehicles (coaches) on the train, or null when unknown (RTT numberOfVehicles). */
  coaches: number | null;
  /** Scheduled origin-to-destination duration in minutes (from the board's
   *  origin/destination endpoint times), or null when RTT doesn't carry them. */
  journeyMins: number | null;
  /** True when this service will not run, or will not call at this station. */
  cancelled: boolean;
}

/** One advertised stop on a service's full run (origin -> destination). */
export interface CallingPoint {
  /** Station name (RTT `location.description`). */
  station: string;
  /** Timetable time at this stop (arrival where advertised; else the departure,
   * e.g. at the origin). ISO 8601. */
  scheduledTime: string;
  /** Expected (live) time at this stop, from the SAME element as scheduledTime
   * so the pair is direction-consistent. Equal to scheduledTime when "on time". */
  expectedTime: string;
  /** Recorded actual ARRIVAL time, ISO 8601. Present once the train has arrived
   *  and TRUST reported it (RTT `arrival.realtimeActual`). Absent at the origin
   *  (it only departs there). This is the truth behind "Arrived HH:MM". */
  actualArrival?: string;
  /** Recorded actual DEPARTURE time, ISO 8601. Present once the train has left
   *  and TRUST reported it (RTT `departure.realtimeActual`). Absent at the
   *  terminus (it only arrives there). This is the truth behind "Departed
   *  HH:MM" — never the arrival time. */
  actualDeparture?: string;
  /** Timetable departure time, ISO 8601 (RTT `departure.scheduleAdvertised`),
   *  present when the stop has a departure element. Lets the UI judge whether a
   *  recorded departure ran on time. */
  scheduledDeparture?: string;
  /** True when RTT has NO live report for this stop (RTT `realtimeNoReport`).
   *  With no forecast, estimate, or actual either, the expected time is just the
   *  timetable — the UI must NOT present it as "on time". */
  noReport?: boolean;
  /** Platform at this stop, or null when not announced. */
  platform: Platform | null;
  /** True when THIS stop is cancelled (RTT `displayAs === 'CANCELLED'`). */
  cancelled: boolean;
}

/** A single train run with its full public calling pattern. */
export interface ServiceDetail {
  /** RTT `uniqueIdentity` (the id the page was opened with). */
  id: string;
  /** Scheduled origin name. */
  origin: string;
  /** Scheduled final destination name. */
  destination: string;
  /** Train Operating Company running this service. */
  operator: string;
  /** Number of passenger vehicles (coaches), or null when unknown. */
  coaches: number | null;
  /** True when any advertised stop is cancelled. */
  cancelled: boolean;
  /** Ordered calling points (origin first). Public stops only. */
  points: CallingPoint[];
}

/**
 * Wire format for a service-detail response (mirrors `BoardResponse`). Carries
 * the stale-while-error signal: `asAt` drives the "last updated" timestamp;
 * `stale` is true when cached data is served because the upstream fetch failed.
 */
export interface ServiceDetailResponse {
  detail: ServiceDetail;
  asAt: number;
  stale: boolean;
}

export type BoardKind = 'departures' | 'arrivals';

/** A live, time-ordered board of services at one station. */
export interface Board {
  /** CRS code of the station this board belongs to. */
  station: string;
  kind: BoardKind;
  services: Service[];
}

/**
 * Wire format between the Cloudflare Worker proxy and the client.
 * Carries the stale-while-error signal (ADR-0003): `asAt` drives the "last
 * updated" timestamp; `stale` is true when cached data is served because the
 * upstream fetch failed.
 */
export interface BoardResponse {
  board: Board;
  asAt: number;
  stale: boolean;
}

/**
 * A change between two boards worth announcing to a screen-reader user (ADR-0002);
 * Routine churn (a service departed and left the list; expected time drifted < 5 min;
 * a new service scrolled into the next-12 window) is NOT a meaningful change.
 */
export type MeaningfulChange =
  | { type: 'cancellation'; serviceId: string }
  | {
      type: 'platform-change';
      serviceId: string;
      from: Platform | null;
      to: Platform | null;
    }
  | { type: 'delay'; serviceId: string; minutesSwing: number };
