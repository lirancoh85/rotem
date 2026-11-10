import { useEffect, useId, useRef, useState } from 'react';
import type { Appointment, Staff } from '../domain/types';
import { parseSearchDate } from '../domain/customers';
import { fmtTime, formatHebrewDate, formatHebrewDateShort, todayLocal, utcToLocal } from '../lib/time';
import { he } from '../i18n/he';
import { Modal } from './Modal';

/** Header search: by customer name, phone number or date (past and future). */
export function SearchDialog(p: {
  staff: Staff[];
  tz: string;
  search(query: string, date: string | null): Promise<Appointment[]>;
  onPick(appt: Appointment): void;
  onClose(): void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Appointment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const today = todayLocal(p.tz);
  const date = parseSearchDate(q, today);

  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    const text = q.trim();
    if (!date && text.length < 2) {
      seq.current++;
      setResults(null);
      setBusy(false);
      return;
    }
    const n = ++seq.current;
    setBusy(true);
    const t = setTimeout(() => {
      p.search(date ? '' : text, date)
        .then((r) => n === seq.current && setResults(r))
        .catch(() => n === seq.current && setResults([]))
        .finally(() => n === seq.current && setBusy(false));
    }, 220);
    return () => clearTimeout(t);
  }, [q, date]); // eslint-disable-line react-hooks/exhaustive-deps

  const staffName = (sid: string) => p.staff.find((s) => s.id === sid)?.name ?? '';
  const staffIdx = (sid: string) => p.staff.findIndex((s) => s.id === sid);

  return (
    <Modal title={he.searchTitle} onClose={p.onClose} labelledBy={`${id}-t`}>
      <div className="search">
        <h2 id={`${id}-t`}>{he.searchTitle}</h2>
        <label className="field">
          <span className="visually-hidden">{he.search}</span>
          <input
            ref={input}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={he.searchPlaceholder}
            enterKeyHint="search"
            autoComplete="off"
            aria-describedby={`${id}-hint`}
          />
        </label>
        <p id={`${id}-hint`} className="muted search-hint">
          {date ? he.searchDateResults(formatHebrewDate(date)) : he.searchHint}
        </p>

        <div aria-live="polite">
          {busy && results === null && <p className="muted">{he.searchSearching}</p>}
          {results && results.length === 0 && !busy && <p className="muted">{he.searchNoResults}</p>}
          {results && results.length > 0 && (
            <ul className="search-results" data-testid="search-results">
              {results.map((a) => {
                const s = utcToLocal(a.startsAt, p.tz);
                const e = utcToLocal(a.endsAt, p.tz);
                const past = s.date < today;
                return (
                  <li key={a.id}>
                    <button type="button" className="result" onClick={() => p.onPick(a)}>
                      <span className="result-name">{a.customerName}</span>
                      <span className="result-when">
                        <span>{formatHebrewDateShort(s.date)}</span>
                        <bdi dir="ltr">
                          {fmtTime(s.minutes)}–{fmtTime(e.minutes)}
                        </bdi>
                      </span>
                      <span className={`result-staff staff-${staffIdx(a.staffId)}`}>{staffName(a.staffId)}</span>
                      {a.customerPhone && (
                        <bdi dir="ltr" className="result-phone">
                          {a.customerPhone}
                        </bdi>
                      )}
                      <span className={`result-tag ${past ? 'past' : 'upcoming'}`}>{past ? he.past : he.upcoming}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
