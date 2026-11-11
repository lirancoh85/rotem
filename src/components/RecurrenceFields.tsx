import { useId } from 'react';
import type { RecurrenceRule } from '../domain/recurrence';
import { MAX_OCCURRENCES } from '../domain/recurrence';
import { addDays } from '../lib/time';
import { he } from '../i18n/he';

/** Repeat options for a new appointment: none / every 1–4 weeks / custom; end by count or date. */
export function RecurrenceFields(p: { date: string; rule: RecurrenceRule | null; onChange(rule: RecurrenceRule | null): void }) {
  const id = useId();
  const presets = [1, 2, 3, 4];
  const custom = p.rule && !presets.includes(p.rule.intervalWeeks);
  const set = (patch: Partial<RecurrenceRule>) =>
    p.onChange({ intervalWeeks: 1, end: { kind: 'count', count: 6 }, ...(p.rule ?? {}), ...patch } as RecurrenceRule);

  return (
    <fieldset className="field recurrence" data-testid="recurrence">
      <legend>{he.repeat}</legend>
      <div className="segmented wrap" role="radiogroup" aria-label={he.repeat}>
        <button type="button" role="radio" aria-checked={!p.rule} className={`seg ${!p.rule ? 'on' : ''}`} onClick={() => p.onChange(null)}>
          {he.repeatNone}
        </button>
        {presets.map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={p.rule?.intervalWeeks === n}
            className={`seg ${p.rule?.intervalWeeks === n ? 'on' : ''}`}
            onClick={() => set({ intervalWeeks: n })}
          >
            {he.repeatEvery(n)}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={!!custom} className={`seg ${custom ? 'on' : ''}`} onClick={() => set({ intervalWeeks: 5 })}>
          {he.repeatCustom}
        </button>
      </div>

      {p.rule && (
        <div className="recurrence-details">
          {custom && (
            <label className="field">
              <span>{he.repeatCustomWeeks}</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={52}
                value={p.rule.intervalWeeks}
                onChange={(e) => set({ intervalWeeks: Math.max(1, Math.min(52, Number(e.target.value) || 1)) })}
              />
            </label>
          )}
          <div className="field-row">
            <fieldset className="field">
              <legend>{he.repeatEnd}</legend>
              <div className="segmented" role="radiogroup" aria-label={he.repeatEnd}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={p.rule.end.kind === 'count'}
                  className={`seg ${p.rule.end.kind === 'count' ? 'on' : ''}`}
                  onClick={() => set({ end: { kind: 'count', count: 6 } })}
                >
                  {he.repeatCount}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={p.rule.end.kind === 'until'}
                  className={`seg ${p.rule.end.kind === 'until' ? 'on' : ''}`}
                  onClick={() => set({ end: { kind: 'until', date: addDays(p.date, 7 * 12) } })}
                >
                  {he.repeatUntil}
                </button>
              </div>
            </fieldset>
            {p.rule.end.kind === 'count' ? (
              <label className="field">
                <span id={`${id}-c`}>{he.repeatCount}</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={MAX_OCCURRENCES}
                  value={p.rule.end.count}
                  aria-labelledby={`${id}-c`}
                  onChange={(e) => set({ end: { kind: 'count', count: Math.max(1, Math.min(MAX_OCCURRENCES, Number(e.target.value) || 1)) } })}
                />
              </label>
            ) : (
              <label className="field">
                <span>{he.repeatUntil}</span>
                <input type="date" min={p.date} value={p.rule.end.date} onChange={(e) => e.target.value && set({ end: { kind: 'until', date: e.target.value } })} />
              </label>
            )}
          </div>
        </div>
      )}
    </fieldset>
  );
}
