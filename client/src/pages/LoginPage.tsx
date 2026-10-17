import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { ErrorBanner } from '../components/ui';

/**
 * The one door in, when Grocer is reachable from the internet: the
 * household's shared password. A login lasts until the password or the
 * server's login generation changes, so this is seen once per device.
 */
export default function LoginPage() {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      // Everything fetched while logged out was refused: fetch it all again.
      await qc.invalidateQueries();
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <form
        className="login__card stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="login__brand">
          <img src="/icon.svg" alt="" width={40} height={40} />
          <h1>Grocer</h1>
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <ErrorBanner error={error} />
        <button className="btn btn--primary btn--block btn--lg" type="submit" disabled={!password || busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
        <p className="small faint" style={{ margin: 0 }}>
          This device stays logged in.
        </p>
      </form>
    </main>
  );
}
