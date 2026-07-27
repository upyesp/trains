// Domain types for the trains site, derived from CONTEXT.md.
// Shared DTO contract between the Cloudflare Worker (proxy) and the Astro client.
// Pure domain shapes — no implementation details.

/** A platform assignment. Either provisional (planned) or confirmed (live, announced). */
export interface Platform {
  /** The platform number/letter as displayed, e.g. "3". */
  number: string;
  /** Whether the station has confirmed this platform yet. A provisional platform can still change. */
  state: 'provisional' | 'confirmed';
}

/** A single scheduled train run — a departure from, or arrival at, a station. */
export interface Service {
  /** Stable identity across refreshes (RTT service id / train UID). Used to match previous↔current. */
  id: string;
  /** Scheduled departure/arrival time, ISO 8601. */
  scheduledTime: string;
  /** Expected (live predicted) departure/arrival time, ISO 8601. May differ from scheduledTime. */
  expectedTime: string;
  /** Platform, or null when not yet announced. */
  platform: Platform | null;
  /** Final destination (departures) or origin (arrivals). */
  destination: string;
  /** The Train Operating Company running this service. */
  operator: string;
  /** True when this service will not run, or will not call at this station. */
  cancelled: boolean;
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
 * A change between two boards worth announcing to a screen-reader user (ADR-0002).
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
