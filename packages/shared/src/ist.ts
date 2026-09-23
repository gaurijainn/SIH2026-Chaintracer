/**
 * UTC -> Asia/Kolkata (IST, UTC+5:30, no DST) conversion for the paired UTC+IST timestamp display
 * the B9 evidence report's hop table needs. Uses `Intl.DateTimeFormat` (built into Node) rather than
 * a date library, since IST has a fixed offset and no DST rules to track.
 */
export interface IstTimestamp {
  /** Original instant, ISO-8601 UTC (e.g. "2026-09-23T11:47:40.000Z"). */
  iso: string;
  /** Human-readable IST rendering, e.g. "23 Sep 2026, 17:17:40 IST". */
  display: string;
}

const IST_FORMATTER = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function toIst(date: Date): IstTimestamp {
  if (Number.isNaN(date.getTime())) throw new TypeError('toIst: invalid Date');
  const parts = IST_FORMATTER.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    iso: date.toISOString(),
    display: `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute}:${parts.second} IST`,
  };
}
