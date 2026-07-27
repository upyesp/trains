import { describe, expect, it } from 'vitest';
import { mapLocationLineUp } from './mapper';
import type { RTTLocationResponse, RTTService } from './rtt';

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
            operator: 'South Western Railway',
            cancelled: false,
          },
        ],
      });
    });
  });

  describe('platform state', () => {
    it('is confirmed when actual is set, provisional when only planned, null when neither', () => {
      const resp: RTTLocationResponse = {
        services: [
          service({ id: 'confirmed', locationMetadata: { platform: { planned: '1', actual: '1' } } }),
          service({ id: 'provisional', locationMetadata: { platform: { planned: '2' } } }),
          service({ id: 'none' }), // no locationMetadata at all
        ],
      };

      const board = mapLocationLineUp(resp, 'WAT', 'departures');
      const byId = Object.fromEntries(board.services.map((s) => [s.id, s.platform]));

      expect(byId).toEqual({
        confirmed: { number: '1', state: 'confirmed' },
        provisional: { number: '2', state: 'provisional' },
        none: null,
      });
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
});
