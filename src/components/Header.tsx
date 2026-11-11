import logo from '../assets/logo.png';
import type { ConnectionStatus } from '../data/backend';
import { he } from '../i18n/he';

export function Header(p: {
  status: ConnectionStatus;
  demo: boolean;
  onSettings(): void;
  onSearch(): void;
  onCustomers?(): void;
  onWaitlist?(): void;
  /** number of waiting-list requests that match a free slot right now */
  waitlistMatches?: number;
}) {
  return (
    <header className="app-header">
      <div className="brand">
        <img src={logo} alt={he.salonName} className="brand-logo" width={165} height={165} />
        <div className="brand-text">
          <h1 className="brand-name">{he.salonName}</h1>
          <span className={`status status-${p.status}`} role="status">
            <span className="dot" aria-hidden="true" />
            {he.status[p.status]}
            {p.demo && <span className="demo-badge">{he.demoBadge}</span>}
          </span>
        </div>
      </div>
      <div className="header-actions">
      <button type="button" className="icon-btn search-btn" onClick={p.onSearch} aria-label={he.search} title={he.search} data-testid="search-btn">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <span className="search-label">{he.search}</span>
      </button>
      {p.onCustomers && (
        <button type="button" className="icon-btn" onClick={p.onCustomers} aria-label={he.customers} title={he.customers} data-testid="customers-btn">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="9" cy="8" r="3.5" />
            <path d="M2.5 20c.8-3.6 3.4-5.5 6.5-5.5s5.7 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.5.8 2.6 2.6 3 5.2" />
          </svg>
        </button>
      )}
      {p.onWaitlist && (
        <button
          type="button"
          className={`icon-btn waitlist-btn ${p.waitlistMatches ? 'has-badge' : ''}`}
          onClick={p.onWaitlist}
          aria-label={p.waitlistMatches ? `${he.waitlist} · ${he.waitlistMatchesBadge(p.waitlistMatches)}` : he.waitlist}
          title={he.waitlist}
          data-testid="waitlist-btn"
        >
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="13" r="8" />
            <path d="M12 9v4l2.5 2M9 2.5h6" />
          </svg>
          {!!p.waitlistMatches && <span className="badge" aria-hidden="true">{p.waitlistMatches}</span>}
        </button>
      )}
      <button type="button" className="icon-btn" onClick={p.onSettings} aria-label={he.settings} title={he.settings}>
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
        </svg>
      </button>
      </div>
    </header>
  );
}
