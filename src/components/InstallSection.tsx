import { useEffect, useState } from 'react';
import { canPromptInstall, isStandalone, onInstallAvailability, platform, promptInstall } from '../lib/install';
import { he } from '../i18n/he';

/** Install instructions for iPhone Safari and Android Chrome, plus a one-tap install where supported. */
export function InstallSection() {
  const [can, setCan] = useState(canPromptInstall);
  const [installed, setInstalled] = useState(isStandalone);
  useEffect(() => onInstallAvailability(() => {
    setCan(canPromptInstall());
    setInstalled(isStandalone());
  }), []);
  const os = platform();
  const order = os === 'ios' ? (['ios', 'android'] as const) : (['android', 'ios'] as const);

  return (
    <section className="install" aria-labelledby="install-title" data-testid="install-section">
      <h3 id="install-title">{he.installTitle}</h3>
      {installed ? (
        <p className="muted">{he.installInstalled}</p>
      ) : (
        <>
          {can && (
            <button type="button" className="btn primary" onClick={() => void promptInstall()}>
              {he.installButton}
            </button>
          )}
          {order.map((k) => (
            <div key={k} className="install-steps">
              <h4>{k === 'ios' ? he.installIosTitle : he.installAndroidTitle}</h4>
              <ol>
                {(k === 'ios' ? he.installIosSteps : he.installAndroidSteps).map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
