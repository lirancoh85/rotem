import { useEffect, useRef, type ReactNode } from 'react';
import { he } from '../i18n/he';

export function Modal(p: { title: string; labelledBy?: string; onClose(): void; children: ReactNode; size?: 'sm' | 'md' }) {
  const ref = useRef<HTMLDivElement>(null);
  // latest onClose without re-running the mount effect (a re-render — e.g. a live
  // update from another device — must not move focus out of the field being typed in)
  const onCloseRef = useRef(p.onClose);
  onCloseRef.current = p.onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      // only when the dialog really closes: give focus back to where it was
      if (!document.querySelector('[role=dialog]')) document.body.classList.remove('modal-open');
      prev?.focus?.();
    };
  }, []);

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
