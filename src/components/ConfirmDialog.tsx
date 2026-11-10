import { Modal } from './Modal';
import { he } from '../i18n/he';

export function ConfirmDialog(p: { title: string; message: string; confirmLabel: string; onConfirm(): void; onCancel(): void }) {
  return (
    <Modal title={p.title} onClose={p.onCancel} size="sm">
      <div className="confirm">
        <h2>{p.title}</h2>
        <p>{p.message}</p>
        <div className="form-actions">
          <button type="button" className="btn danger" onClick={p.onConfirm} autoFocus>
            {p.confirmLabel}
          </button>
          <button type="button" className="btn ghost" onClick={p.onCancel}>
            {he.cancel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
