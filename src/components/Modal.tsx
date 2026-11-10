import { useEffect, useRef, type ReactNode } from 'react';
import { he } from '../i18n/he';

export function Modal(p: { title: string; labelledBy?: string; onClose(): void; children: ReactNode; size?: 'sm' | 'md' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
      prev?.focus?.();
    };
  }, [p.onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div
        ref={ref}
        className={`sheet sheet-${p.size ?? 'md'}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={p.labelledBy}
        aria-label={p.labelledBy ? undefined : p.title}
      >
        <button type="button" className="sheet-close" onClick={p.onClose} aria-label={he.close}>
          ×
        </button>
        {p.children}
      </div>
    </div>
  );
}
