import { describe, expect, it } from 'vitest';
import {
  blocksRequiringSplit, buildColumn, canMergeBlock, canSplitBlock, findOverlap, toDayAppointments, validateAppointment,
} from './schedule';
import { D, ROTEM, SIVAN, appt, split } from '../test/fixtures';

const col = (staffId: string, appts = [] as ReturnType<typeof appt>[], splits = [] as ReturnType<typeof split>[]) =>
  buildColumn({ staffId, date: D, dayStart: 9 * 60, dayEnd: 11 * 60, dayAppts: toDayAppointments(appts, D), splits })
    .map((c) => `${c.kind === 'free' ? (c.split ? 'free15' : 'free30') : `appt:${c.appt.customerName}`}@${c.start}-${c.end}`);

describe('independent staff schedules', () => {
  it('overlap checks only consider the same staff member', () => {
    const day = toDayAppointments([appt(ROTEM, '09:00', 30)], D);
    expect(findOverlap(day, ROTEM.id, 540, 570)).toBeDefined();
    expect(findOverlap(day, SIVAN.id, 540, 570)).toBeUndefined();
  });
  it('validates overlaps per staff, allows back-to-back, and longer durations', () => {
    const day = toDayAppointments([appt(ROTEM, '09:00', 60, 'גלעד')], D);
    const base = { customerName: 'x', staffId: ROTEM.id };
    expect(validateAppointment(day, { ...base, start: 570, duration: 30 })).toBe('OVERLAP');
    expect(validateAppointment(day, { ...base, start: 600, duration: 45 })).toBeNull();
    expect(validateAppointment(day, { ...base, staffId: SIVAN.id, start: 540, duration: 60 })).toBeNull();
    expect(validateAppointment(day, { ...base, start: 545, duration: 30 })).toBe('OFF_GRID');
    expect(validateAppointment(day, { ...base, customerName: ' ', start: 660, duration: 30 })).toBe('NAME_REQUIRED');
  });
  it('editing an appointment does not collide with itself', () => {
    const a = appt(ROTEM, '09:00', 30);
    const day = toDayAppointments([a], D);
    expect(validateAppointment(day, { customerName: 'x', staffId: ROTEM.id, start: 540, duration: 45 }, a.id)).toBeNull();
  });
});

describe('15/30-minute rendering', () => {
  it('renders an empty day as 30-minute blocks', () => {
    expect(col(ROTEM.id)).toEqual(['free30@540-570', 'free30@570-600', 'free30@600-630', 'free30@630-660']);
  });
  it('renders a split block as two 15-minute cells, only for that staff member', () => {
    const splits = [split(ROTEM, '09:00')];
    expect(col(ROTEM.id, [], splits).slice(0, 3)).toEqual(['free15@540-555', 'free15@555-570', 'free30@570-600']);
    expect(col(SIVAN.id, [], splits)[0]).toBe('free30@540-570');
  });
  it('renders the example: two 15-minute customers for Rotem, a 30-minute one for Sivan', () => {
    const appts = [appt(ROTEM, '09:00', 15, 'דניאל'), appt(ROTEM, '09:15', 15, 'אבי'), appt(SIVAN, '09:00', 30, 'משה')];
    const splits = [split(ROTEM, '09:00')];
    expect(col(ROTEM.id, appts, splits).slice(0, 2)).toEqual(['appt:דניאל@540-555', 'appt:אבי@555-570']);
    expect(col(SIVAN.id, appts, splits)[0]).toBe('appt:משה@540-570');
  });
  it('one booked half leaves the other half free', () => {
    const appts = [appt(ROTEM, '09:15', 15, 'אבי')];
    expect(col(ROTEM.id, appts, [split(ROTEM, '09:00')]).slice(0, 2)).toEqual(['free15@540-555', 'appt:אבי@555-570']);
  });
  it('a 30-minute appointment can span two 15-minute intervals across blocks', () => {
    const appts = [appt(ROTEM, '09:15', 30, 'רוני')];
    const splits = [split(ROTEM, '09:00'), split(ROTEM, '09:30')];
    expect(col(ROTEM.id, appts, splits).slice(0, 3)).toEqual(['free15@540-555', 'appt:רוני@555-585', 'free15@585-600']);
  });
  it('45 and 60-minute appointments render as one cell', () => {
    const appts = [appt(ROTEM, '09:00', 60, 'ארוך'), appt(ROTEM, '10:00', 45, 'בינוני')];
    expect(col(ROTEM.id, appts, [split(ROTEM, '10:30')])).toEqual([
      'appt:ארוך@540-600', 'appt:בינוני@600-645', 'free15@645-660',
    ]);
  });
  it('a reverted (is_split=false) block renders as 30 minutes again', () => {
    expect(col(ROTEM.id, [], [split(ROTEM, '09:00', false)])[0]).toBe('free30@540-570');
  });
  it('offers split on free 30-minute blocks and merge only on empty split blocks', () => {
    const cells = buildColumn({
      staffId: ROTEM.id, date: D, dayStart: 540, dayEnd: 630, splits: [split(ROTEM, '09:00'), split(ROTEM, '09:30')],
      dayAppts: toDayAppointments([appt(ROTEM, '09:30', 15)], D),
    });
    const free = cells.filter((c) => c.kind === 'free');
    expect(free.map((c) => c.kind === 'free' && [c.start, c.canSplit, c.canMerge])).toEqual([
      [540, false, true], [555, false, false], [585, false, false], [600, true, false],
    ]);
  });
});

describe('split rules', () => {
  it('cannot split under an occupying appointment; can split around it', () => {
    const day = toDayAppointments([appt(ROTEM, '09:00', 30), appt(ROTEM, '10:00', 60)], D);
    expect(canSplitBlock(day, ROTEM.id, 540)).toBe(false);
    expect(canSplitBlock(day, ROTEM.id, 630)).toBe(false);
    expect(canSplitBlock(day, SIVAN.id, 540)).toBe(true);
    expect(canSplitBlock(day, ROTEM.id, 570)).toBe(true);
  });
  it('cannot merge while a 15-minute boundary exists', () => {
    const day = toDayAppointments([appt(ROTEM, '09:00', 15)], D);
    expect(canMergeBlock(day, ROTEM.id, 540)).toBe(false);
    expect(canMergeBlock(day, SIVAN.id, 540)).toBe(true);
  });
  it('knows which blocks a booking must split', () => {
    expect(blocksRequiringSplit(540, 555)).toEqual([540]);
    expect(blocksRequiringSplit(555, 585)).toEqual([540, 570]);
    expect(blocksRequiringSplit(540, 600)).toEqual([]);
  });
});
