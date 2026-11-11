import logo from '../assets/logo.png';
import { he } from '../i18n/he';

/** Friendly full-screen state when the app cannot reach the server at all. */
export function OfflineScreen() {
  return (
    <main className="offline-screen" role="alert" data-testid="offline-screen">
      <img src={logo} alt={he.salonName} width={96} height={96} className="offline-logo" />
      <h1>{he.offlineTitle}</h1>
      <p>{he.offlineText}</p>
      <button type="button" className="btn primary" onClick={() => location.reload()}>
        {he.tryAgain}
      </button>
    </main>
  );
}
