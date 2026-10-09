import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, session } from '../lib/api';

export function Login({ onLogin }: { onLogin: (u: any) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const loc = useLocation() as any;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api('/api/auth/login', { body: { email, password } });
      session.token = r.token;
      onLogin(r.user);
      nav(loc.state?.from ?? '/', { replace: true });
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card col" onSubmit={submit} style={{ gap: 16 }}>
        <div className="row" style={{ gap: 12 }}>
          <span className="logo" style={{ width: 44, height: 44, borderRadius: 12 }}><svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 9h18M3 14h18M3 19h18" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></svg></span>
          <div><h2 style={{ margin: 0 }}>Yellowstone</h2><div className="sub">Onsite sales & deck estimator</div></div>
        </div>
        <input className="input" type="email" autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {err && <div className="issue blocker"><span className="ico">!</span>{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
