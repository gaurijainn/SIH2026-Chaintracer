/**
 * The one place user-facing timestamps are formatted. Everything is shown in IST (Asia/Kolkata) with an explicit "IST" suffix;
 * missing or unparsable values render as an em dash rather than a made-up time. Date-only strings ("2026-09-23", already an IST
 * calendar day from the API) are shown as that day without any timezone shift.
 */
const TZ = 'Asia/Kolkata';
const MISSING = '—';

const dateTime = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const time = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: TZ });
const date = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ });
const dayMonth = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', timeZone: 'UTC' });

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Epoch ms for an ISO string, Date or number; null when absent or invalid. */
export function toMs(v: string | number | Date | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** "23 Sep 2026, 14:05 IST" */
export function formatIst(v: string | number | Date | null | undefined): string {
  const ms = toMs(v);
  return ms === null ? MISSING : `${dateTime.format(ms)} IST`;
}

/** "14:05:09 IST" */
export function formatIstTime(v: string | number | Date | null | undefined): string {
  const ms = toMs(v);
  return ms === null ? MISSING : `${time.format(ms)} IST`;
}

/** "23 Sep 2026" for an instant (IST calendar day), or for a date-only string as-is. */
export function formatIstDate(v: string | number | Date | null | undefined): string {
  if (typeof v === 'string') {
    const m = DATE_ONLY.exec(v);
    if (m) return date.format(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!) + 12 * 3_600_000);
  }
  const ms = toMs(v);
  return ms === null ? MISSING : date.format(ms);
}

/** "23 Sep" for a date-only API day (no timezone conversion). */
export function formatDayMonth(day: string | null | undefined): string {
  const m = day ? DATE_ONLY.exec(day) : null;
  return m ? dayMonth.format(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!)) : MISSING;
}
