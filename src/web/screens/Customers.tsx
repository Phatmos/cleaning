import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Nav } from '../components/Shell';
import { api } from '../lib/api';
import { Empty, Field, Sheet, useToast } from '../components/ui';

export function Customers() {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<any>({ state: 'KY' });
  const nav = useNavigate();
  const toast = useToast();
  useEffect(() => {
    const t = setTimeout(() => api(`/api/customers?q=${encodeURIComponent(q)}`).then(setRows).catch(() => setRows([])), 200);
    return () => clearTimeout(t);
  }, [q]);
  const create = async () => {
    try {
      const r = await api('/api/customers', { body: form });
      nav(`/customers/${r.id}`);
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <div className="app">
      <Nav title="Customers" right={<button className="btn primary small" onClick={() => setAdding(true)}>＋ New</button>} />
      <main className="page">
        <input className="input" placeholder="Search name, address, phone, email" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 16 }} />
        {rows === null ? <div className="card">Loading…</div> : rows.length === 0 ? <div className="card"><Empty title="No customers found" /></div> : (
          <div className="group">
            {rows.map((c) => (
              <Link key={c.id} to={`/customers/${c.id}`} className="item chev" style={{ color: 'var(--text)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{c.name}</div>
                  <div className="sub">{[c.address, c.city].filter(Boolean).join(', ') || 'No address'}</div>
                </div>
                {c.zoho_contact_id && <span className="pill blue">Zoho</span>}
                <span className="pill">{c.estimate_count} estimate{c.estimate_count === 1 ? '' : 's'}</span>
              </Link>
            ))}
          </div>
        )}
      </main>
      <Sheet open={adding} onClose={() => setAdding(false)} title="New customer" footer={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" onClick={create} disabled={!form.name}>Create</button></>}>
        <div className="small" style={{ marginBottom: 12 }}>Customers normally arrive from Zoho. Create one here only if it is not in the CRM yet — it will be matched by Zoho contact ID when sync is connected.</div>
        <div className="grid two">
          {[['name', 'Full name'], ['phone', 'Phone'], ['email', 'Email'], ['address', 'Street address'], ['city', 'City'], ['zip', 'ZIP']].map(([k, l]) => (
            <Field key={k} label={l}><input className="input" value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
