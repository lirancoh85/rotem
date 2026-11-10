import logo from '../assets/logo.png';
import type { ConnectionStatus } from '../data/backend';
import { he } from '../i18n/he';

const CalendarIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
    <path d="M3.5 10h17M8 3v4M16 3v4" />
  </svg>
);
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </svg>
);
const GearIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

/**
 * Brand + navigation. On tablets/desktop it is a side panel (right side in RTL);
 * on phones and portrait tablets it collapses into a slim top bar.
 */
export function Header(p: { status: ConnectionStatus; demo: boolean; onSettings(): void; onSearch(): void }) {
  return (
    <header className="app-header">
      <div className="brand">
        <img src={logo} alt={he.salonName} className="brand-logo" width={165} height={165} />
        <div className="brand-text">
          <h1 className="brand-name">{he.salonName}</h1>
          <span className="brand-sub">{he.brandSub}</span>
        </div>
      </div>

      <nav className="side-nav" aria-label={he.menu}>
        <span className="nav-heading">{he.menu}</span>
        <span className="nav-item is-current" aria-current="page">
          <CalendarIcon />
          <span className="nav-label">{he.navDiary}</span>
        </span>
        <div className="header-actions">
          <button
            type="button"
            className="icon-btn nav-item search-btn"
            onClick={p.onSearch}
            aria-label={he.search}
            title={he.search}
            data-testid="search-btn"
          >
            <SearchIcon />
            <span className="search-label nav-label">{he.search}</span>
          </button>
          <button type="button" className="icon-btn nav-item" onClick={p.onSettings} aria-label={he.settings} title={he.settings}>
            <GearIcon />
            <span className="nav-label">{he.settings}</span>
          </button>
        </div>
      </nav>

      <div className="side-foot">
        <span className={`status status-${p.status}`} role="status">
          <span className="dot" aria-hidden="true" />
          {he.status[p.status]}
          {p.demo && <span className="demo-badge">{he.demoBadge}</span>}
        </span>
      </div>
    </header>
  );
}
