/** All wall-clock handling is done in the salon's timezone, independent of the device timezone. */
export const SALON_TZ = 'Asia/Jerusalem';

const partsFormatter = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = partsFormatter.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormatter.set(tz, f);
  }
  return f;
}

function wallParts(utcMs: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of fmt(tz).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of tz from UTC (minutes) at the given instant. */
function offsetMinutes(utcMs: number, tz: string) {
  const p = wallParts(utcMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/** 'YYYY-MM-DD' + minutes since local midnight (may be 1440) -> UTC epoch ms. */
export function localToUtcMs(date: string, minutes: number, tz = SALON_TZ): number {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, minutes);
  let utc = naive - offsetMinutes(naive, tz) * 60000;
  const off2 = offsetMinutes(utc, tz);
  utc = naive - off2 * 60000;
  return utc;
}

export function localToIso(date: string, minutes: number, tz = SALON_TZ): string {
  return new Date(localToUtcMs(date, minutes, tz)).toISOString();
}

/** UTC instant -> salon-local date + minutes since midnight. */
export function utcToLocal(iso: string | number, tz = SALON_TZ): { date: string; minutes: number } {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  const p = wallParts(ms, tz);
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, minutes: p.hour * 60 + p.minute };
}

export function todayLocal(tz = SALON_TZ, now = Date.now()): string {
  return utcToLocal(now, tz).date;
}

export function nowMinutesLocal(tz = SALON_TZ, now = Date.now()): number {
  return utcToLocal(now, tz).minutes;
}

export function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** minutes -> 'HH:MM' (24h) */
export function fmtTime(minutes: number): string {
  return `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
}

/** 'HH:MM' or 'HH:MM:SS' -> minutes */
export function parseTime(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Calendar arithmetic on 'YYYY-MM-DD' strings (timezone-free). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

const longDate = new Intl.DateTimeFormat('he-IL', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const shortDate = new Intl.DateTimeFormat('he-IL', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' });

function dateAsUtc(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** e.g. "יום שלישי, 10 בנובמבר 2026" */
export function formatHebrewDate(date: string): string {
  return longDate.format(dateAsUtc(date));
}
/** e.g. "יום ג׳, 10.11" */
export function formatHebrewDateShort(date: string): string {
  return shortDate.format(dateAsUtc(date));
}

export function durationLabel(min: number): string {
  if (min === 60) return 'שעה';
  if (min === 90) return 'שעה וחצי';
  if (min === 120) return 'שעתיים';
  return `${min} דק׳`;
}
