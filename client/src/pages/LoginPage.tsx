import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { LanguageSwitcher, useT } from '../lib/i18n';

export default function LoginPage() {
  const { login } = useAuth();
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <div className="login-head">
          <h1>{t('app.name')}</h1>
          <LanguageSwitcher compact />
        </div>
        <p className="muted">{t('app.tagline')}</p>
        <label>
          {t('login.username')}
          <input autoFocus value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </label>
        <label>
          {t('login.password')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <div className="field-error">{error}</div>}
        <button className="btn btn-primary" disabled={busy || !username || !password}>
          {busy ? t('login.busy') : t('login.submit')}
        </button>
      </form>
    </div>
  );
}
