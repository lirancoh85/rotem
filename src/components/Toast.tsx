import { useEffect } from 'react';

export interface ToastMsg {
  id: number;
  text: string;
  tone?: 'ok' | 'error';
  action?: { label: string; run(): void };
  /** optional second action (e.g. undo next to show) */
  action2?: { label: string; run(): void };
}

export function Toast(p: { toast: ToastMsg | null; onDone(): void }) {
  useEffect(() => {
    if (!p.toast) return;
    const t = setTimeout(p.onDone, p.toast.action ? 6000 : p.toast.tone === 'error' ? 5000 : 2200);
    return () => clearTimeout(t);
  }, [p.toast, p.onDone]);
  return (
    <div className="toast-wrap" aria-live="polite">
      {p.toast && (
        <div className={`toast ${p.toast.tone ?? 'ok'}`} role={p.toast.tone === 'error' ? 'alert' : 'status'}>
          <span>{p.toast.text}</span>
          {[p.toast.action, p.toast.action2].filter(Boolean).map((a) => (
            <button
              key={a!.label}
              type="button"
              onClick={() => {
                a!.run();
                p.onDone();
              }}
            >
              {a!.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
