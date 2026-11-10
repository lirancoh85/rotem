import { useRef } from 'react';
import type { Staff } from '../domain/types';
import { addDays, formatHebrewDate, todayLocal } from '../lib/time';
import { he } from '../i18n/he';

export function DateBar(p: {
  date: string;
  onDate(d: string): void;
  staff: Staff[];
  filter: string;
  onFilter(f: string): void;
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
      <div className="datebar-nav">
        {/* RTL: "previous" sits on the right, "next" on the left */}
        <button type="button" className="icon-btn" onClick={() => p.onDate(addDays(p.date, -1))} aria-label={he.prevDay}>
          ›
        </button>
        <button type="button" className="date-label" onClick={openPicker} aria-label={`${he.pickDate}: ${formatHebrewDate(p.date)}`}>
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
        <button type="button" className="icon-btn" onClick={() => p.onDate(addDays(p.date, 1))} aria-label={he.nextDay}>
          ‹
        </button>
        <button type="button" className={`btn today ${isToday ? 'is-today' : ''}`} onClick={() => p.onDate(todayLocal())}>
          {he.today}
        </button>
      </div>
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
  );
}
