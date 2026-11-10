import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Hebrew + RTL for the whole document, even when embedded in a host page
document.documentElement.lang = 'he';
document.documentElement.dir = 'rtl';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Offline-capable PWA shell (production only; never caches Supabase API traffic)
if ('serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.MODE !== 'demo') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
