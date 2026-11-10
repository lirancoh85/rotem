import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import logo from '../assets/logo.png';
import { he } from '../i18n/he';

export function LoginScreen({ sb }: { sb: SupabaseClient }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(/fetch|network/i.test(error.message) ? he.errors.NETWORK : he.login.failed);
  };
  return (
    <main className="login">
      <form className="login-card" onSubmit={submit}>
        <img src={logo} alt={he.salonName} className="login-logo" width={165} height={165} />
        <h1>{he.login.title}</h1>
        {error && <div className="form-error" role="alert">{error}</div>}
        <label className="field">
          <span>{he.login.email}</span>
          <input type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label className="field">
          <span>{he.login.password}</span>
          <input type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <button type="submit" className={`btn primary ${busy ? 'is-saving' : ''}`} disabled={busy}>
          {busy ? he.login.submitting : he.login.submit}
        </button>
      </form>
    </main>
  );
}
