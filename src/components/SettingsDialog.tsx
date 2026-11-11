import { useState } from 'react';
import { Modal } from './Modal';
import { InstallSection } from './InstallSection';
import { fmtTime } from '../lib/time';
import { he } from '../i18n/he';

const HOURS = Array.from({ length: 48 }, (_, i) => i * 30);

export function SettingsDialog(p: {
  dayStart: number;
  dayEnd: number;
  demo: boolean;
  closedWeekdays?: number[];
  onSaveClosedDays?(days: number[]): Promise<void>;
  onSaveHours(start: number, end: number): Promise<void>;
  onSignOut(): void;
  onClose(): void;
}) {
  const [start, setStart] = useState(p.dayStart);
  const [end, setEnd] = useState(p.dayEnd);
  const [busy, setBusy] = useState(false);
  const valid = end > start;
  return (
    <Modal title={he.settings} onClose={p.onClose} size="sm">
      <div className="settings">
        <h2>{he.settings}</h2>
        <fieldset className="field">
          <legend>{he.hours}</legend>
          <div className="field-row">
            <label className="field">
              <span>{he.hoursFrom}</span>
              <select value={start} onChange={(e) => setStart(Number(e.target.value))} dir="ltr">
                {HOURS.map((m) => <option key={m} value={m}>{fmtTime(m)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{he.hoursTo}</span>
              <select value={end} onChange={(e) => setEnd(Number(e.target.value))} dir="ltr">
                {[...HOURS.slice(1), 1440].map((m) => <option key={m} value={m}>{m === 1440 ? '24:00' : fmtTime(m)}</option>)}
              </select>
            </label>
          </div>
        </fieldset>
        {p.closedWeekdays && p.onSaveClosedDays && (
          <fieldset className="field">
            <legend>{he.closedDays}</legend>
            <div className="weekday-toggles" role="group" aria-label={he.closedDays}>
              {he.weekdays.map((w, i) => {
                const on = p.closedWeekdays!.includes(i);
                return (
                  <button
                    key={w}
                    type="button"
                    aria-pressed={on}
                    className={`chip ${on ? 'on' : ''}`}
                    onClick={() => void p.onSaveClosedDays!(on ? p.closedWeekdays!.filter((d) => d !== i) : [...p.closedWeekdays!, i])}
                  >
                    {w}
                  </button>
                );
              })}
            </div>
            <span className="muted small">{he.closedDaysHint}</span>
          </fieldset>
        )}
        <InstallSection />
        {p.demo && <p className="muted">{he.demoNote}</p>}
        <div className="form-actions">
          <button
            type="button"
            className="btn primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await p.onSaveHours(start, end);
              } finally {
                setBusy(false);
              }
            }}
          >
            {he.saveChanges}
          </button>
          <button type="button" className="btn ghost" onClick={p.onSignOut}>
            {p.demo ? he.resetDemo : he.signOut}
          </button>
        </div>
      </div>
    </Modal>
  );
}
