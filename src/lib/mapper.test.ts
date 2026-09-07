import { describe, expect, it } from 'vitest';
import { mapLocationLineUp, mapServiceDetail } from './mapper';
import type { RTTLocationResponse, RTTService, RTTServiceDetailResponse, RTTServiceLocationItem } from './rtt';

/**
 * Build a minimal RTT service, overriding only what each test cares about.
 * Defaults describe a "calling" service that both arrives and departs, with
 * origin London Waterloo and destination Weymouth.
 */
function service(over: Partial<RTTService> & { id: string }): RTTService {
  return {
    scheduleMetadata: {
      uniqueIdentity: over.id,
      operator: over.scheduleMetadata?.operator ?? { name: 'South Western Railway' },
    },
    // temporalData is replaced wholesale when overridden (a partial override
    // must not inherit the default arrival/departure — see the selection tests).
    temporalData:
      over.temporalData ?? {
        displayAs: 'CALL',
        arrival: { scheduleAdvertised: '2026-07-27T08:00:00+01:00' },
        departure: { scheduleAdvertised: '2026-07-27T08:05:00+01:00' },
      },
    locationMetadata: over.locationMetadata,
    origin: over.origin ?? [{ location: { description: 'London Waterloo' } }],
    destination: over.destination ?? [{ location: { description: 'Weymouth' } }],
  };
}

describe('mapLocationLineUp', () => {
  describe('a normal departure', () => {
    it('maps id, times, destination, operator, and a confirmed platform', () => {
      const resp: RTTLocationResponse = {
        services: [
          service({
            id: 'gb-nr:L01525:2026-07-27',
            locationMetadata: { platform: { planned: '3', actual: '3' } },
            temporalData: {
              displayAs: 'CALL',
              departure: {
                scheduleAdvertised: '2026-07-27T08:05:00+01:00',
                realtimeForecast: '2026-07-27T08:08:00+01:00',
              },
            },
          }),
        ],
      };

      expect(mapLocationLineUp(resp, 'WAT', 'departures')).toEqual({
        station: 'WAT',
        kind: 'departures',
        services: [
          {
            id: 'gb-nr:L01525:2026-07-27',
            scheduledTime: '2026-07-27T08:05:00+01:00',
            expectedTime: '2026-07-27T08:08:00+01:00',
            platform: { number: '3', state: 'confirmed' },
            destination: 'Weymouth',
            origin: 'London Waterloo',
            finalDestination: 'Weymouth',
            operator: 'South Western Railway',
            coaches: null,
            journeyMins: null,
            cancelled: false,
          },
        ],
      });
    });
  });

  describe('journey time', () => {
    it('derives the origin→destination duration from the endpoint times', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({
              id: 'fast',
              origin: [{ location: { description: 'A' }, temporalData: { scheduleAdvertised: '2026-08-03T10:00:00' } }],
              destination: [{ location: { description: 'B' }, temporalData: { scheduleAdvertised: '2026-08-03T11:30:00' } }],
              temporalData: { displayAs: 'CALL', departure: { scheduleAdvertised: '2026-08-03T10:00:00' } },
            }),
            service({ id: 'no-times' }), // endpoints without temporalData
          ],
        },
        'WAT',
        'departures',
      );
      const byId = Object.fromEntries(board.services.map((s) => [s.id, s.journeyMins]));
      expect(byId).toEqual({ fast: 90, 'no-times': null });
    });
  });

  describe('coaches (numberOfVehicles)', () => {
    it('maps the passenger-vehicle count when present and positive', () => {
      const board = mapLocationLineUp(
        { services: [service({ id: 'x', locationMetadata: { numberOfVehicles: 8 } })] },
        'WAT',
        'departures',
      );
      expect(board.services).toEqual([expect.objectContaining({ coaches: 8 })]);
    });

    it('is null when numberOfVehicles is absent, zero, or negative', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({ id: 'absent' }),
            service({ id: 'zero', locationMetadata: { numberOfVehicles: 0 } }),
            service({ id: 'neg', locationMetadata: { numberOfVehicles: -1 } }),
          ],
        },
        'WAT',
        'departures',
      );
      expect(board.services.map((s) => s.coaches)).toEqual([null, null, null]);
    });
  });

  describe('platform state', () => {
    it('is at-platform when status is AT_PLATFORM, confirmed when actual is set, provisional when only planned, null when neither', () => {
      const resp: RTTLocationResponse = {
        services: [
          service({ id: 'at-platform', locationMetadata: { platform: { planned: '1', actual: '1' } }, temporalData: { displayAs: 'CALL', status: 'AT_PLATFORM', departure: { scheduleAdvertised: '2026-07-27T08:05:00+01:00' } } }),
          service({ id: 'confirmed', locationMetadata: { platform: { planned: '1', actual: '1' } } }),
          service({ id: 'provisional', locationMetadata: { platform: { planned: '2' } } }),
          service({ id: 'none' }), // no locationMetadata at all
        ],
      };

      const board = mapLocationLineUp(resp, 'WAT', 'departures');
      const byId = Object.fromEntries(board.services.map((s) => [s.id, s.platform]));

      expect(byId).toEqual({
        'at-platform': { number: '1', state: 'at-platform' },
        confirmed: { number: '1', state: 'confirmed' },
        provisional: { number: '2', state: 'provisional' },
        none: null,
      });
    });

    it('treats at-platform as at-platform even when only a planned number is present', () => {
      // RTT reports the train at the platform but only the planned number is set
      // (defensive): the live status is authoritative.
      const board = mapLocationLineUp(
        {
          services: [
            service({ id: 'ap', locationMetadata: { platform: { planned: '9' } }, temporalData: { displayAs: 'CALL', status: 'AT_PLATFORM', departure: { scheduleAdvertised: '2026-07-27T08:05:00+01:00' } } }),
          ],
        },
        'WAT',
        'departures',
      );
      expect(board.services[0]?.platform).toEqual({ number: '9', state: 'at-platform' });
    });
  });

  describe('expected time fallback chain', () => {
    it('uses realtimeForecast when present', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({
              id: 'x',
              temporalData: {
                displayAs: 'CALL',
                departure: {
                  scheduleAdvertised: '2026-07-27T08:05:00+01:00',
                  realtimeForecast: '2026-07-27T08:12:00+01:00',
                },
              },
            }),
          ],
        },
        'WAT',
        'departures',
      );
      expect(board.services).toEqual([
        expect.objectContaining({ expectedTime: '2026-07-27T08:12:00+01:00' }),
      ]);
    });

    it('falls back to realtimeEstimate when there is no forecast', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({
              id: 'x',
              temporalData: {
                displayAs: 'CALL',
                departure: {
                  scheduleAdvertised: '2026-07-27T08:05:00+01:00',
                  realtimeEstimate: '2026-07-27T08:09:00+01:00',
                },
              },
            }),
          ],
        },
        'WAT',
        'departures',
      );
      expect(board.services).toEqual([
        expect.objectContaining({ expectedTime: '2026-07-27T08:09:00+01:00' }),
      ]);
    });

    it('falls back to the scheduled time ("on time") when there is no realtime at all', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({
              id: 'x',
              temporalData: {
                displayAs: 'CALL',
                departure: { scheduleAdvertised: '2026-07-27T08:05:00+01:00' },
              },
            }),
          ],
        },
        'WAT',
        'departures',
      );
      expect(board.services).toEqual([
        expect.objectContaining({ expectedTime: '2026-07-27T08:05:00+01:00' }),
      ]);
    });
  });

  describe('cancellation', () => {
    it('is flagged but still present on the board (demoted by the UI, not dropped)', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({
              id: 'can',
              temporalData: {
                displayAs: 'CANCELLED',
                departure: { scheduleAdvertised: '2026-07-27T08:05:00+01:00' },
              },
            }),
          ],
        },
        'WAT',
        'departures',
      );
      expect(board.services).toEqual([expect.objectContaining({ cancelled: true })]);
      expect(board.services).toHaveLength(1);
    });
  });

  describe('departures vs arrivals selection', () => {
    // A CALL appears on both; a STARTS service departs only; a TERMINATES service
    // arrives only; a PASS (through, no advertised stop) appears on neither.
    const D = (h: string) => `2026-07-27T${h}:00+01:00`;
    const services: RTTService[] = [
      service({
        id: 'call',
        temporalData: {
          displayAs: 'CALL',
          arrival: { scheduleAdvertised: D('07:58') },
          departure: { scheduleAdvertised: D('08:05') },
        },
      }),
      service({
        id: 'starts',
        temporalData: { displayAs: 'STARTS', departure: { scheduleAdvertised: D('08:10') } },
      }),
      service({
        id: 'terminates',
        temporalData: { displayAs: 'TERMINATES', arrival: { scheduleAdvertised: D('08:20') } },
      }),
      service({ id: 'pass', temporalData: { displayAs: 'PASS' } }),
    ];

    it('departures include CALL and STARTS, exclude TERMINATES and PASS', () => {
      const board = mapLocationLineUp({ services }, 'WAT', 'departures');
      expect(board.services.map((s) => s.id)).toEqual(['call', 'starts']);
    });

    it('arrivals include CALL and TERMINATES, exclude STARTS and PASS', () => {
      const board = mapLocationLineUp({ services }, 'WAT', 'arrivals');
      expect(board.services.map((s) => s.id)).toEqual(['call', 'terminates']);
    });

    it('departures show the destination; arrivals show the origin (the "other end")', () => {
      const dep = mapLocationLineUp({ services: [services[0]!] }, 'WAT', 'departures');
      const arr = mapLocationLineUp({ services: [services[0]!] }, 'WAT', 'arrivals');
      // The DTO field is named `destination`; for an arrivals board it holds the origin.
      expect(dep.services).toEqual([expect.objectContaining({ destination: 'Weymouth' })]);
      expect(arr.services).toEqual([expect.objectContaining({ destination: 'London Waterloo' })]);
    });

    it('carries the true origin and final destination on both board kinds', () => {
      const dep = mapLocationLineUp({ services: [services[0]!] }, 'WAT', 'departures');
      const arr = mapLocationLineUp({ services: [services[0]!] }, 'WAT', 'arrivals');
      // origin = the train's start (origin[0]); finalDestination = its far end
      // (destination[last]) — independent of which end the row labels.
      expect(dep.services).toEqual([
        expect.objectContaining({ origin: 'London Waterloo', finalDestination: 'Weymouth' }),
      ]);
      expect(arr.services).toEqual([
        expect.objectContaining({ origin: 'London Waterloo', finalDestination: 'Weymouth' }),
      ]);
    });
  });

  describe('empty board', () => {
    it('returns an empty services array for a 204-style empty response', () => {
      expect(mapLocationLineUp({ services: [] }, 'WAT', 'departures')).toEqual({
        station: 'WAT',
        kind: 'departures',
        services: [],
      });
    });

    it('treats a missing services field as empty', () => {
      expect(mapLocationLineUp({}, 'WAT', 'departures').services).toEqual([]);
    });
  });

  describe('ordering', () => {
    it('sorts services by scheduled time ascending', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({
              id: 'late',
              temporalData: { displayAs: 'CALL', departure: { scheduleAdvertised: '2026-07-27T09:00:00+01:00' } },
            }),
            service({
              id: 'early',
              temporalData: { displayAs: 'CALL', departure: { scheduleAdvertised: '2026-07-27T08:00:00+01:00' } },
            }),
          ],
        },
        'WAT',
        'departures',
      );
      expect(board.services.map((s) => s.id)).toEqual(['early', 'late']);
    });
  });

  describe('actual times and the no-report flag', () => {
    it('maps the recorded actual and the no-report flag from the chosen temporal element', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({
              id: 'reported',
              temporalData: {
                displayAs: 'CALL',
                departure: {
                  scheduleAdvertised: '2026-07-27T08:05:00+01:00',
                  realtimeActual: '2026-07-27T08:11:00+01:00',
                },
              },
            }),
            service({
              id: 'unreported',
              temporalData: {
                displayAs: 'CALL',
                departure: {
                  scheduleAdvertised: '2026-07-27T08:12:00+01:00',
                  realtimeNoReport: true,
                },
              },
            }),
          ],
        },
        'WAT',
        'departures',
      );
      const [reported, unreported] = board.services;
      expect(reported).toMatchObject({ actualTime: '2026-07-27T08:11:00+01:00' });
      expect(reported).not.toHaveProperty('noReport');
      expect(unreported).toMatchObject({
        expectedTime: '2026-07-27T08:12:00+01:00',
        noReport: true,
      });
      expect(unreported).not.toHaveProperty('actualTime');
    });

    it('omits actualTime/noReport keys entirely when RTT does not supply them', () => {
      const board = mapLocationLineUp(
        {
          services: [
            service({
              id: 'plain',
              temporalData: { displayAs: 'CALL', departure: { scheduleAdvertised: '2026-07-27T08:05:00+01:00' } },
            }),
          ],
        },
        'WAT',
        'departures',
      );
      const s = board.services[0]!;
      expect('actualTime' in s).toBe(false);
      expect('noReport' in s).toBe(false);
    });
  });
});

/** Build a service-location item (one stop on the full run), overriding the
 * bits each test cares about. Defaults to a normal CALL with an arrival and
 * departure at Clapham Junction. */
function stop(over: Partial<RTTServiceLocationItem> & { station?: string }): RTTServiceLocationItem {
  return {
    location: { description: over.station ?? 'Clapham Junction' },
    temporalData: over.temporalData ?? {
      displayAs: 'CALL',
      arrival: { scheduleAdvertised: '2026-07-27T08:02:00+01:00' },
      departure: { scheduleAdvertised: '2026-07-27T08:03:00+01:00' },
    },
    locationMetadata: over.locationMetadata,
  };
}

describe('mapServiceDetail', () => {
  const D = (h: string) => `2026-07-27T${h}:00+01:00`;

  it('maps each advertised stop in order with station, times and platform', () => {
    const resp: RTTServiceDetailResponse = {
      service: {
        scheduleMetadata: {
          uniqueIdentity: 'gb-nr:L1:2026-07-27',
          operator: { name: 'South Western Railway' },
        },
        origin: [{ location: { description: 'London Waterloo' } }],
        destination: [{ location: { description: 'Weymouth' } }],
        locations: [
          stop({ station: 'London Waterloo', temporalData: { displayAs: 'STARTS', departure: { scheduleAdvertised: D('08:05') } } }),
          stop({ station: 'Clapham Junction', temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:11') }, departure: { scheduleAdvertised: D('08:12') } }, locationMetadata: { platform: { planned: '3', actual: '3' } } }),
          stop({ station: 'Weymouth', temporalData: { displayAs: 'TERMINATES', arrival: { scheduleAdvertised: D('10:02') } } }),
        ],
      },
    };

    expect(mapServiceDetail(resp, 'gb-nr:L1:2026-07-27')).toEqual({
      id: 'gb-nr:L1:2026-07-27',
      origin: 'London Waterloo',
      destination: 'Weymouth',
      operator: 'South Western Railway',
      coaches: null,
      cancelled: false,
      points: [
        { station: 'London Waterloo', scheduledTime: D('08:05'), expectedTime: D('08:05'), scheduledDeparture: D('08:05'), platform: null, cancelled: false },
        { station: 'Clapham Junction', scheduledTime: D('08:12'), expectedTime: D('08:12'), scheduledDeparture: D('08:12'), platform: { number: '3', state: 'confirmed' }, cancelled: false },
        { station: 'Weymouth', scheduledTime: D('10:02'), expectedTime: D('10:02'), platform: null, cancelled: false },
      ],
    });
  });

  it('prefers the departure time; the terminus (TERMINATES) has no departure so shows its arrival', () => {
    const detail = mapServiceDetail(
      {
        service: {
          scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
          locations: [
            stop({ station: 'Origin', temporalData: { displayAs: 'STARTS', departure: { scheduleAdvertised: D('09:00') } } }),
            stop({ station: 'Mid', temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('09:30') }, departure: { scheduleAdvertised: D('09:31') } } }),
            stop({ station: 'Terminus', temporalData: { displayAs: 'TERMINATES', arrival: { scheduleAdvertised: D('10:02') } } }),
          ],
        },
      },
      'x',
    );
    expect(detail.points.map((p) => p.scheduledTime)).toEqual([D('09:00'), D('09:31'), D('10:02')]);
  });

  it('reads expected time from the SAME element as the scheduled time (departure delay against departure)', () => {
    const detail = mapServiceDetail(
      {
        service: {
          scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
          locations: [
            stop({
              temporalData: {
                displayAs: 'CALL',
                arrival: { scheduleAdvertised: D('08:11'), realtimeForecast: D('08:18') },
                departure: { scheduleAdvertised: D('08:12'), realtimeForecast: D('08:20') },
              },
            }),
          ],
        },
      },
      'x',
    );
    expect(detail.points[0]).toEqual(
      expect.objectContaining({ scheduledTime: D('08:12'), expectedTime: D('08:20') }),
    );
  });

  it('falls back to schedule ("on time") when there is no realtime data', () => {
    const detail = mapServiceDetail(
      {
        service: {
          scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
          locations: [stop({ temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:11') } } })],
        },
      },
      'x',
    );
    expect(detail.points[0]!.expectedTime).toBe(D('08:11'));
  });

  it('excludes PASS, DIVERTED, and stops with no displayAs', () => {
    const detail = mapServiceDetail(
      {
        service: {
          scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
          locations: [
            stop({ station: 'Call', temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:11') } } }),
            stop({ station: 'Pass', temporalData: { displayAs: 'PASS', pass: { scheduleAdvertised: D('08:15') } } }),
            stop({ station: 'Diverted', temporalData: { displayAs: 'DIVERTED', arrival: { scheduleAdvertised: D('08:20') } } }),
            stop({ station: 'NoDisplayAs', temporalData: {} }),
          ],
        },
      },
      'x',
    );
    expect(detail.points.map((p) => p.station)).toEqual(['Call']);
  });

  it('maps platform state per stop (confirmed / provisional / none)', () => {
    const detail = mapServiceDetail(
      {
        service: {
          scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
          locations: [
            stop({ station: 'A', locationMetadata: { platform: { planned: '1', actual: '1' } }, temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:01') } } }),
            stop({ station: 'B', locationMetadata: { platform: { planned: '2' } }, temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:02') } } }),
            stop({ station: 'C', temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:03') } } }),
          ],
        },
      },
      'x',
    );
    expect(detail.points.map((p) => p.platform)).toEqual([
      { number: '1', state: 'confirmed' },
      { number: '2', state: 'provisional' },
      null,
    ]);
  });

  it('flags the service cancelled when any advertised stop is cancelled', () => {
    const detail = mapServiceDetail(
      {
        service: {
          scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
          locations: [
            stop({ station: 'A', temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:01') } } }),
            stop({ station: 'B', temporalData: { displayAs: 'CANCELLED', arrival: { scheduleAdvertised: D('08:02') } } }),
          ],
        },
      },
      'x',
    );
    expect(detail.cancelled).toBe(true);
    expect(detail.points.map((p) => p.cancelled)).toEqual([false, true]);
  });

  it('takes coaches from the first location carrying a positive vehicle count', () => {
    const detail = mapServiceDetail(
      {
        service: {
          scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
          locations: [
            stop({ station: 'A', locationMetadata: { numberOfVehicles: 0 }, temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:01') } } }),
            stop({ station: 'B', locationMetadata: { numberOfVehicles: 8 }, temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:02') } } }),
          ],
        },
      },
      'x',
    );
    expect(detail.coaches).toBe(8);
  });

  it('falls back to the first/last calling point when origin/destination pairs are absent', () => {
    const detail = mapServiceDetail(
      {
        service: {
          scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
          locations: [
            stop({ station: 'FirstStop', temporalData: { displayAs: 'STARTS', departure: { scheduleAdvertised: D('08:00') } } }),
            stop({ station: 'LastStop', temporalData: { displayAs: 'TERMINATES', arrival: { scheduleAdvertised: D('09:00') } } }),
          ],
        },
      },
      'x',
    );
    expect(detail.origin).toBe('FirstStop');
    expect(detail.destination).toBe('LastStop');
  });

  it('returns the echoed id and empty points when the service is absent', () => {
    expect(mapServiceDetail({}, 'gb-nr:gone:2026-07-27')).toEqual({
      id: 'gb-nr:gone:2026-07-27',
      origin: '',
      destination: '',
      operator: '',
      coaches: null,
      cancelled: false,
      points: [],
    });
  });

  describe('actual times and the no-report flag', () => {
    it('maps arrival/departure actuals separately and the no-report flag', () => {
      const detail = mapServiceDetail(
        {
          service: {
            scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
            locations: [
              stop({
                station: 'Reported',
                temporalData: {
                  displayAs: 'CALL',
                  arrival: { scheduleAdvertised: D('08:11'), realtimeActual: D('08:19') },
                  departure: { scheduleAdvertised: D('08:12'), realtimeActual: D('08:21') },
                },
              }),
              stop({
                station: 'Unreported',
                temporalData: {
                  displayAs: 'CALL',
                  arrival: { scheduleAdvertised: D('08:20'), realtimeNoReport: true },
                },
              }),
            ],
          },
        },
        'x',
      );
      // The departure is the chosen element for the primary times; the actuals
      // stay element-typed so "Departed" can never show an arrival time.
      expect(detail.points[0]).toMatchObject({
        scheduledTime: D('08:12'),
        expectedTime: D('08:12'),
        actualArrival: D('08:19'),
        actualDeparture: D('08:21'),
        scheduledDeparture: D('08:12'),
      });
      expect(detail.points[1]).toMatchObject({ noReport: true });
      expect(detail.points[1]).not.toHaveProperty('actualArrival');
      expect(detail.points[1]).not.toHaveProperty('actualDeparture');
    });

    it('omits the actual/noReport keys when RTT does not supply them', () => {
      const detail = mapServiceDetail(
        {
          service: {
            scheduleMetadata: { uniqueIdentity: 'x', operator: { name: 'SWR' } },
            locations: [stop({ temporalData: { displayAs: 'CALL', arrival: { scheduleAdvertised: D('08:11') } } })],
          },
        },
        'x',
      );
      const p = detail.points[0]!;
      expect('actualArrival' in p).toBe(false);
      expect('actualDeparture' in p).toBe(false);
      expect('scheduledDeparture' in p).toBe(false);
      expect('noReport' in p).toBe(false);
    });
  });
});
