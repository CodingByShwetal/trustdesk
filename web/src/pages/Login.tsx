import { useState, type FormEvent } from 'react';
import { api, describeError, type Role, type Session } from '../api';

const ROLES: Array<{ role: Role; label: string; can: string }> = [
  { role: 'agent', label: 'Support agent', can: 'Triage tickets, generate drafts, request actions' },
  { role: 'manager', label: 'Support manager', can: 'Also approve, reject and execute sensitive actions' },
  { role: 'admin', label: 'Admin', can: 'Also ingest knowledge and run evaluations' },
];

export function Login({ onSignIn }: { onSignIn: (s: Session) => void }) {
  const [role, setRole] = useState<Role>('agent');
  const [password, setPassword] = useState('trustdesk');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSignIn(await api<Session>('/auth/login', { method: 'POST', body: { username: role, password } }));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form onSubmit={submit}>
        <div>
          <h1>TrustDesk</h1>
          <p className="muted">AI drafts the reply. You decide what gets sent and done.</p>
        </div>
        <fieldset className="roles" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="faint" style={{ marginBottom: 8 }}>Sign in as</legend>
          {ROLES.map((r) => (
            <label key={r.role}>
              <input type="radio" name="role" value={r.role} checked={role === r.role} onChange={() => setRole(r.role)} />
              <strong>{r.label}</strong>
              <small>{r.can}</small>
            </label>
          ))}
        </fieldset>
        <label className="faint">
          Demo password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: '100%', marginTop: 4 }} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
