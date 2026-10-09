import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, session } from '../lib/api';
import { RefDataProvider } from '../lib/refdata';

export interface Me { id: string; name: string; email: string; role: 'admin' | 'manager' | 'salesman' }
let meCache: Me | null = null;
export const setMe = (u: Me) => { meCache = u; try { localStorage.setItem('ys.me', JSON.stringify(u)); } catch { /* ignore */ } };
export const useMe = () => meCache!;

export function Authed({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(meCache);
  const [failed, setFailed] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    if (meCache || !session.token) return;
    api('/api/me').then((r) => { meCache = r.user; setMe(r.user); }).catch(() => {
      // Offline with a stored session: allow working on cached drafts.
      const cachedMe = (() => { try { return JSON.parse(localStorage.getItem('ys.me') ?? 'null'); } catch { return null; } })();
      if (cachedMe && !navigator.onLine) { meCache = cachedMe; setMe(cachedMe); } else setFailed(true);
    });
  }, []);
  if (!session.token || failed) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  if (!me) return <div className="empty">Loading…</div>;
  return <RefDataProvider>{children}</RefDataProvider>;
}

export function Nav({ title, back, right }: { title?: ReactNode; back?: string; right?: ReactNode }) {
  const me = useMe();
  const nav = useNavigate();
  return (
    <header className="nav">
      {back ? <button className="btn ghost small" onClick={() => nav(back)} style={{ paddingLeft: 4 }}>‹ Back</button> : (
        <Link to="/" className="brand" style={{ color: 'var(--text)' }}>
          <span className="logo"><svg width="18" height="18" viewBox="0 0 24 24"><path d="M3 9h18M3 14h18M3 19h18" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" /></svg></span>
          <span className="hide-sm">Yellowstone</span>
        </Link>
      )}
      <div className="title">{title}</div>
      {right}
      {!back && (
        <nav className="row" style={{ gap: 4 }}>
          <Link className="btn ghost small" to="/">Visits</Link>
          <Link className="btn ghost small" to="/customers">Customers</Link>
          {me.role !== 'salesman' && <Link className="btn ghost small" to="/admin">Admin</Link>}
          <button className="btn ghost small" onClick={() => { void api('/api/auth/logout', { method: 'POST' }).catch(() => undefined); session.token = null; meCache = null; location.href = '/login'; }}>Sign out</button>
        </nav>
      )}
    </header>
  );
}

