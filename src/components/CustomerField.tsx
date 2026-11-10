import { forwardRef, useEffect, useId, useRef, useState, type InputHTMLAttributes } from 'react';
import type { Customer } from '../domain/types';
import { normalizePhone } from '../domain/customers';
import { formatHebrewDateShort, utcToLocal } from '../lib/time';
import { he } from '../i18n/he';

export type CustomerLookup = (query: string) => Promise<Customer[]>;

/** Debounced returning-customer suggestions. Stale responses are ignored. */
export function useCustomerSuggestions(lookup: CustomerLookup | undefined, query: string, enabled: boolean) {
  const [results, setResults] = useState<Customer[]>([]);
  const seq = useRef(0);
  useEffect(() => {
    const q = query.trim();
    const digits = normalizePhone(q);
    const meaningful = q.length >= 2 || (digits !== null && digits.length >= 3);
    if (!lookup || !enabled || !meaningful) {
      seq.current++;
      setResults([]);
      return;
    }
    const id = ++seq.current;
    const t = setTimeout(() => {
      lookup(q)
        .then((r) => id === seq.current && setResults(r))
        .catch(() => id === seq.current && setResults([]));
    }, 140);
    return () => clearTimeout(t);
  }, [lookup, query, enabled]);
  return results;
}

type Props = {
  label: string;
  value: string;
  onValueChange(v: string): void;
  onPick(c: Customer): void;
  lookup?: CustomerLookup;
  /** hide suggestions once a customer has been picked and the text still matches */
  pickedId?: string | null;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>;

/** Text input with a touch-friendly dropdown of matching existing customers. */
export const CustomerField = forwardRef<HTMLInputElement, Props>(function CustomerField(
  { label, value, onValueChange, onPick, lookup, pickedId, ...input },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const [dismissed, setDismissed] = useState(false);
  const results = useCustomerSuggestions(lookup, value, focused && !dismissed && !pickedId);
  const listId = useId();
  const open = focused && !dismissed && !pickedId && results.length > 0;

  useEffect(() => setActive(-1), [results]);

  const pick = (c: Customer) => {
    onPick(c);
    setDismissed(true);
  };

  return (
    <label className="field customer-field">
      <span>{label}</span>
      <div className="ac-wrap">
        <input
          ref={ref}
          {...input}
          value={value}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          onChange={(e) => {
            setDismissed(false);
            onValueChange(e.target.value);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          onKeyDown={(e) => {
            if (!open) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && active >= 0) {
              e.preventDefault();
              pick(results[active]);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setDismissed(true);
            }
          }}
        />
        {open && (
          <ul className="ac-list" role="listbox" id={listId} aria-label={he.customerSuggestions}>
            {results.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`ac-item ${i === active ? 'on' : ''}`}
                // preventDefault on mousedown keeps focus (and the list) while the tap completes
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(c)}
              >
                <span className="ac-avatar" aria-hidden="true">
                  {c.name.trim().charAt(0)}
                </span>
                <span className="ac-name">{c.name}</span>
                <span className="ac-meta">
                  {c.phone && <bdi dir="ltr">{c.phone}</bdi>}
                  {c.lastVisit && <span>{he.lastVisit(formatHebrewDateShort(utcToLocal(c.lastVisit).date))}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </label>
  );
});
