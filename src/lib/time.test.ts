import { describe, expect, it } from 'vitest';
import { addDays, fmtTime, formatHebrewDate, localToIso, parseTime, utcToLocal } from './time';

describe('Asia/Jerusalem time handling (24h)', () => {
  it('converts local wall time to UTC in winter (UTC+2) and summer (UTC+3)', () => {
    expect(localToIso('2026-11-10', 9 * 60)).toBe('2026-11-10T07:00:00.000Z');
    expect(localToIso('2026-07-01', 9 * 60)).toBe('2026-07-01T06:00:00.000Z');
  });
  it('round-trips through DST change days', () => {
    for (const date of ['2026-03-27', '2026-10-25']) {
      for (const m of [8 * 60, 12 * 60 + 15, 19 * 60 + 45]) {
        expect(utcToLocal(localToIso(date, m))).toEqual({ date, minutes: m });
      }
    }
  });
  it('formats 24-hour times and Hebrew dates', () => {
    expect(fmtTime(13 * 60 + 5)).toBe('13:05');
    expect(fmtTime(0)).toBe('00:00');
    expect(parseTime('09:30:00')).toBe(570);
    expect(formatHebrewDate('2026-11-10')).toContain('נובמבר');
    expect(formatHebrewDate('2026-11-10')).toContain('שלישי');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
