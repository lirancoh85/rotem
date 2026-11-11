/**
 * Israeli holidays and non-working days for a calendar date.
 *
 * Jewish holidays come from Hebcal (@hebcal/core) computed with the Israeli
 * schedule (il = true), so it works for any future year. A day is marked as a
 * non-working day (יום שבתון) only when it is one by law in Israel:
 *   - yom tov days (Hebcal's CHAG flag, Israeli schedule),
 *   - Yom HaAtzmaut (Independence Day, including Hebcal's postponement rules),
 *   - Knesset election days (statutory rest day; listed below).
 * Other observances (Chol HaMoed, Chanukah, Purim, fasts, memorial days, eves)
 * are shown by name but are NOT marked as days off.
 */
import { HDate, HebrewCalendar, flags, type Event } from '@hebcal/core';

export interface DayInfo {
  /** Hebrew names of the holidays/special days on this date */
  names: string[];
  /** true only for official non-working days in Israel */
  dayOff: boolean;
}

/**
 * Knesset election days (a statutory rest day — חוק הבחירות לכנסת, סעיף 10).
 * Elections are scheduled by law/Knesset decision, not by a calendar formula,
 * so add new dates here when they are set.
 */
export const ELECTION_DAYS: Record<string, string> = {
  '2019-04-09': 'יום הבחירות לכנסת',
  '2019-09-17': 'יום הבחירות לכנסת',
  '2020-03-02': 'יום הבחירות לכנסת',
  '2021-03-23': 'יום הבחירות לכנסת',
  '2022-11-01': 'יום הבחירות לכנסת',
  '2026-10-27': 'יום הבחירות לכנסת',
};

/** Observances worth showing in a salon diary (by Hebcal description prefix). */
const SHOWN_MINOR = ['Chanukah', 'Tu BiShvat', 'Purim', 'Shushan Purim', 'Lag BaOmer', "Tu B'Av"];
const SHOWN_MODERN = ['Yom HaShoah', 'Yom HaZikaron', "Yom HaAtzma'ut", 'Yom Yerushalayim'];
const SHOWN_EREV = ['Erev Rosh Hashana', 'Erev Yom Kippur', 'Erev Sukkot', 'Erev Pesach', 'Erev Shavuot'];

function isShown(ev: Event): boolean {
  const f = ev.getFlags();
  const desc = ev.getDesc();
  if (f & flags.CHAG) return true;
  if (f & flags.CHOL_HAMOED) return true;
  if (f & (flags.MAJOR_FAST | flags.MINOR_FAST)) return true;
  if (f & flags.MODERN_HOLIDAY) return SHOWN_MODERN.some((p) => desc.startsWith(p));
  if (f & flags.EREV) return SHOWN_EREV.some((p) => desc.startsWith(p));
  if (f & flags.MINOR_HOLIDAY) return SHOWN_MINOR.some((p) => desc.startsWith(p));
  return false;
}

function hebrewName(ev: Event): string {
  const desc = ev.getDesc();
  if (desc.startsWith('Chanukah')) return 'חנוכה';
  if (desc.startsWith('Rosh Hashana') && !desc.endsWith('II')) return 'ראש השנה';
  return ev
    .render('he-x-NoNikud')
    .replace(/\s*\d{4}$/, '') // "ראש השנה 5787" → "ראש השנה"
    .replace(/\s*\(חוה״מ\)/, ' (חול המועד)')
    .trim();
}

const cache = new Map<string, DayInfo | null>();

/** Holiday info for a salon-local date 'YYYY-MM-DD', or null when it is an ordinary day. */
export function israelDayInfo(date: string): DayInfo | null {
  if (cache.has(date)) return cache.get(date)!;
  const [y, m, d] = date.split('-').map(Number);
  const events = HebrewCalendar.getHolidaysOnDate(new HDate(new Date(y, m - 1, d)), true) ?? [];
  const names: string[] = [];
  let dayOff = false;
  for (const ev of events) {
    if (!isShown(ev)) continue;
    const name = hebrewName(ev);
    if (!names.includes(name)) names.push(name);
    if (ev.getFlags() & flags.CHAG) dayOff = true;
    if (ev.getDesc().startsWith("Yom HaAtzma'ut")) dayOff = true;
  }
  if (ELECTION_DAYS[date]) {
    names.push(ELECTION_DAYS[date]);
    dayOff = true;
  }
  const info = names.length ? { names, dayOff } : null;
  cache.set(date, info);
  return info;
}
