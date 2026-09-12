/**
 * Parse an RTT timestamp into an absolute instant (ms since the epoch).
 *
 * RTT times are UK wall-clock "naive" ISO strings — `2026-09-12T10:17:00`
 * carries no UTC offset. `Date.parse` reads such strings in the DEVICE's
 * timezone, so for anyone outside the UK every "has the train gone yet?"
 * comparison fired hours early or late: a traveller one hour ahead of UK
 * time saw trains that were still at the platform reported as "Departed on
 * time", with the journey track showing them gone. Anchor naive strings to
 * Europe/London instead: the zone's own offset for that date (GMT in winter,
 * BST in summer) is resolved with Intl and the string is parsed against it.
 *
 * Strings that already carry an explicit offset (or `Z`) are absolute and
 * pass straight through to `Date.parse`.
 *
 * The offset is resolved in two passes so the result is a fixed point across
 * a DST jump (the second pass re-reads the offset at the first-pass instant).
 * The only residual ambiguity is the repeated wall-clock hour in the autumn
 * changeover — unknowable from a naive timestamp alone and irrelevant for
 * departures boards.
 */
const london = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/London',
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Offset of Europe/London (ms) at the instant `asUTC`, read off the zone's
 *  own wall clock: what the zone calls that instant minus the instant. */
function londonOffsetMs(asUTC: number): number {
  const get = (type: string): number =>
    Number(london.formatToParts(new Date(asUTC)).find((p) => p.type === type)?.value);
  const read = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24, // some ICU builds render midnight as "24"
    get('minute'),
    get('second'),
  );
  return read - asUTC;
}

export function parseUKTime(iso: string): number {
  // Absolute timestamp (Z or ±hh:mm) — Date.parse already understands it.
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(iso)) return Date.parse(iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(iso);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s = '0'] = m;
  const [Y, MO, D, H, MI, S] = [y, mo, d, h, mi, s].map(Number);
  // Date.UTC silently rolls over out-of-range fields (month 13, hour 99);
  // reject them so junk yields NaN like every other unparseable stamp.
  if (MO < 1 || MO > 12 || D < 1 || D > 31 || H > 23 || MI > 59 || S > 60) return NaN;
  const asUTC = Date.UTC(Y, MO - 1, D, H, MI, S);
  const offset = londonOffsetMs(asUTC - londonOffsetMs(asUTC));
  return asUTC - offset;
}
