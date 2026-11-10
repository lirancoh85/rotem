import { useState } from 'react';
import { Modal } from './Modal';
import { fmtTime } from '../lib/time';
import { he } from '../i18n/he';

const HOURS = Array.from({ length: 48 }, (_, i) => i * 30);

export function SettingsDialog(p: {
  dayStart: number;
  dayEnd: number;
  demo: boolean;
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
