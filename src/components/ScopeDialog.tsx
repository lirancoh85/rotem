import { useId } from 'react';
import { Modal } from './Modal';
import { he } from '../i18n/he';

export type Scope = 'this' | 'future' | 'all';

/** Asks which occurrences of a recurring series an edit or cancellation applies to. */
export function ScopeDialog(p: { mode: 'edit' | 'cancel'; onChoose(scope: Scope): void; onCancel(): void }) {
  const id = useId();
  const title = p.mode === 'edit' ? he.scopeTitleEdit : he.scopeTitleCancel;
  const options: Scope[] = p.mode === 'edit' ? ['this', 'future'] : ['this', 'future', 'all'];
  const label = { this: he.scopeThis, future: he.scopeFuture, all: he.scopeAll };
  return (
    <Modal title={title} onClose={p.onCancel} labelledBy={`${id}-t`} size="sm">
      <div className="confirm scope">
        <h2 id={`${id}-t`}>{title}</h2>
        <p>{p.mode === 'edit' ? he.scopeQuestionEdit : he.scopeQuestionCancel}</p>
        <div className="scope-options">
          {options.map((s) => (
            <button key={s} type="button" className={`btn ${p.mode === 'cancel' ? 'danger' : s === 'this' ? 'primary' : ''}`} onClick={() => p.onChoose(s)}>
              {label[s]}
            </button>
          ))}
        </div>
        {p.mode === 'edit' && <p className="muted small">{he.scopeFutureNote}</p>}
        <button type="button" className="btn ghost" onClick={p.onCancel}>
          {he.cancel}
        </button>
      </div>
    </Modal>
  );
}
