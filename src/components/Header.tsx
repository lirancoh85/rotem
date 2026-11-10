import logo from '../assets/logo.png';
import type { ConnectionStatus } from '../data/backend';
import { he } from '../i18n/he';

export function Header(p: { status: ConnectionStatus; demo: boolean; onSettings(): void }) {
  return (
    <header className="app-header">
      <div className="brand">
        <img src={logo} alt={he.salonName} className="brand-logo" width={165} height={165} />
        <div className="brand-text">
          <h1>{he.salonName}</h1>
          <span className={`status status-${p.status}`} role="status">
            <span className="dot" aria-hidden="true" />
            {he.status[p.status]}
            {p.demo && <span className="demo-badge">{he.demoBadge}</span>}
          </span>
        </div>
      </div>
      <button type="button" className="icon-btn" onClick={p.onSettings} aria-label={he.settings} title={he.settings}>
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
    </header>
  );
}
