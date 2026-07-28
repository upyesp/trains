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
}

/** A named geographic location (RTT `GeographicLocation`, narrowed). */
export interface RTTGeographicLocation {
  description: string;
}

/** An origin/destination pair (RTT `LocationPair`, narrowed). */
export interface RTTLocationPair {
  location: RTTGeographicLocation;
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
