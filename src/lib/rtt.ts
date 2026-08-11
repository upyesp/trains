// RTT NG API response types — a typed subset of the shapes we actually consume.
// Source of truth: RTT's OpenAPI spec; see docs/research/rtt-api.md.
// Models GET /gb-nr/location's `services[]` (NetworkRailLocationLineUpObject),
// narrowed to the fields our `Board` DTO cares about. Unknown fields are ignored.

/** Planned-vs-live pair (RTT `PlannedActualData`). Used for platform, line, path. */
export interface RTTPlannedActual {
  /** Planned (provisional) platform, from the timetable. */
  planned?: string;
  /** Forecast platform — "not currently used" per spec, ignored. */
  forecast?: string;
  /** Actual (confirmed, announced) platform. */
  actual?: string;
}

/** One temporal element of a service-at-location (RTT `IndividualTemporalData`). */
export interface RTTTemporalData {
  /** GBTT advertised time — our scheduledTime. ISO 8601 datetime. */
  scheduleAdvertised?: string;
  /** Working timetable time (internal). Unused. */
  scheduleInternal?: string;
  /** Live forecast — primary source of expectedTime. */
  realtimeForecast?: string;
  /** RTT-computed estimate when there is no report (needs `showEstimateTimeIfNoReport`). */
  realtimeEstimate?: string;
  /** True when there is no realtime report for this element. */
  realtimeNoReport?: boolean;
  /** Recorded actual time. */
  realtimeActual?: string;
  /** True when THIS temporal element is cancelled (per-leg). */
  isCancelled?: boolean;
}

/** How a service relates to this location (RTT `LocationDisplayAs`). */
export type RTTLocationDisplayAs =
  | 'CALL'
  | 'CANCELLED'
  | 'PASS'
  | 'STARTS'
  | 'TERMINATES'
  | 'DIVERTED';

/** Where the train currently is relative to this location (RTT `LocationStatus`).
 *  Absent/null when not reported. We surface only AT_PLATFORM in the UI today. */
export type RTTLocationStatus =
  | 'APPROACHING'
  | 'ARRIVING'
  | 'AT_PLATFORM'
  | 'DEPART_PREPARING'
  | 'DEPART_READY'
  | 'DEPARTING';

/** Per-location metadata (RTT `LocationMetadata`, narrowed). */
export interface RTTLocationMetadata {
  platform?: RTTPlannedActual;
  /** Number of passenger vehicles (coaches) on the train. Absent/0 when unknown. */
  numberOfVehicles?: number;
}

/** The location/time data for a service at this station (RTT `LocationTemporalData`). */
export interface RTTLocationTemporalData {
  arrival?: RTTTemporalData;
  departure?: RTTTemporalData;
  pass?: RTTTemporalData;
  displayAs?: RTTLocationDisplayAs;
  /** Where the train is relative to this location (AT_PLATFORM, DEPARTING, ...).
   *  Location-level (a sibling of arrival/departure/pass), per the RTT spec. */
  status?: RTTLocationStatus | null;
}

/** A named geographic location (RTT `GeographicLocation`, narrowed). */
export interface RTTGeographicLocation {
  description: string;
  /** Official three-letter station code, e.g. "ADV". Present for GB locations. */
  crs?: string;
}

/** An origin/destination pair (RTT `LocationPair`, narrowed). */
export interface RTTLocationPair {
  location: RTTGeographicLocation;
  /** Timing at this endpoint (origin departure / destination arrival). The board
   *  response populates this on its origin/destination pairs, so a service's
   *  end-to-end duration can be derived without a detail call. */
  temporalData?: RTTTemporalData;
}

/** Service operator (narrowed from `ScheduleMetadata.operator`). */
export interface RTTOperator {
  name: string;
}

/** Schedule-level metadata (RTT `ScheduleMetadata`, narrowed). */
export interface RTTScheduleMetadata {
  /** Stable per service-day, e.g. `gb-nr:L01525:2026-07-27`. */
  uniqueIdentity: string;
  operator: RTTOperator;
}

/** One service-at-this-location — a board row (RTT `NetworkRailLocationLineUpObject`, narrowed). */
export interface RTTService {
  scheduleMetadata: RTTScheduleMetadata;
  temporalData: RTTLocationTemporalData;
  locationMetadata?: RTTLocationMetadata;
  origin: RTTLocationPair[];
  destination: RTTLocationPair[];
}

/** Response of GET /gb-nr/location (narrowed). An upstream `204` maps to `{ services: [] }`. */
export interface RTTLocationResponse {
  services?: RTTService[];
}

/** One location in a service's full run (an item of RTT `NetworkRailServiceLocations`). */
export interface RTTServiceLocationItem {
  temporalData: RTTLocationTemporalData;
  locationMetadata?: RTTLocationMetadata;
  location: RTTGeographicLocation;
}

/** The `service` object returned by GET /gb-nr/service (narrowed). */
export interface RTTServiceDetail {
  scheduleMetadata: RTTScheduleMetadata;
  locations?: RTTServiceLocationItem[];
  origin?: RTTLocationPair[];
  destination?: RTTLocationPair[];
}

/** Response of GET /gb-nr/service (narrowed). An upstream `404` means not found. */
export interface RTTServiceDetailResponse {
  service?: RTTServiceDetail;
}
