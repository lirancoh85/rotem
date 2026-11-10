import { useRef } from 'react';
import type { Staff } from '../domain/types';
import { addDays, formatHebrewDate, todayLocal } from '../lib/time';
import { he } from '../i18n/he';

/** Drawn arrows (not ‹ › characters, which browsers mirror inside RTL text). */
const Chevron = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    {dir === 'right' ? <path d="m9 5 7 7-7 7" /> : <path d="m15 5-7 7 7 7" />}
  </svg>
);

/**
 * Right to left: תאריך → יום קודם → היום → יום הבא.
 * In Hebrew the timeline runs right→left, so "previous" points right (back) and "next" points left (forward).
 */
export function DateBar(p: {
  date: string;
  onDate(d: string): void;
  staff: Staff[];
  filter: string;
  onFilter(f: string): void;
  fullDay: boolean;
  onToggleFullDay(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const isToday = p.date === todayLocal();
  const openPicker = () => {
    const el = input.current;
    if (!el) return;
    try {
      el.showPicker();
    } catch {
      el.focus();
      el.click();
    }
  };
  return (
    <div className="datebar">
      <div className="datebar-nav" data-testid="date-nav">
        <button
          type="button"
          className={`date-label ${isToday ? 'is-today' : ''}`}
          onClick={openPicker}
          aria-label={`${he.pickDate}: ${formatHebrewDate(p.date)}`}
          data-testid="nav-date"
        >
          <span data-testid="date-label">{formatHebrewDate(p.date)}</span>
          <input
            ref={input}
            type="date"
            className="visually-hidden-input"
            value={p.date}
            onChange={(e) => e.target.value && p.onDate(e.target.value)}
            tabIndex={-1}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => p.onDate(addDays(p.date, -1))}
          aria-label={he.prevDay}
          title={he.prevDay}
          data-testid="prev-day"
        >
          <Chevron dir="right" />
        </button>
        <button
          type="button"
          className={`btn today ${isToday ? 'is-today' : ''}`}
          onClick={() => p.onDate(todayLocal())}
          data-testid="today"
        >
          {he.today}
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={() => p.onDate(addDays(p.date, 1))}
          aria-label={he.nextDay}
          title={he.nextDay}
          data-testid="next-day"
        >
          <Chevron dir="left" />
        </button>
      </div>
      <div className="datebar-tools">
        <button
          type="button"
          className={`btn view-toggle ${p.fullDay ? 'on' : ''}`}
          onClick={p.onToggleFullDay}
          aria-pressed={p.fullDay}
          data-testid="view-toggle"
        >
          {p.fullDay ? he.normalView : he.fullDay}
        </button>
        <div className="staff-filter" role="radiogroup" aria-label={he.staffFilter}>
          {[{ id: 'all', name: he.showAll }, ...p.staff].map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={p.filter === s.id}
              className={`chip ${p.filter === s.id ? 'on' : ''}`}
              onClick={() => p.onFilter(s.id)}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
