import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Nav, useMe } from '../components/Shell';
import { api, cached } from '../lib/api';
import { Empty, useToast } from '../components/ui';

export function Home() {
  const me = useMe();
  const nav = useNavigate();
  const toast = useToast();
  const [visits, setVisits] = useState<any[] | null>(null);
  const [integrations, setIntegrations] = useState<any[]>([]);
  useEffect(() => {
    cached('visits', () => api('/api/visits')).then(setVisits).catch(() => setVisits([]));
    api('/api/integrations').then(setIntegrations).catch(() => undefined);
  }, []);
  const start = async (a: any) => {
    try {
      const r = await api(`/api/appointments/${a.id}/estimate`, { method: 'POST' });
      nav(`/estimates/${r.id}`);
    } catch (e) { toast((e as Error).message); }
  };
  const zoho = integrations.find((i) => i.key === 'zoho-crm');
  const byDay = new Map<string, any[]>();
  for (const v of visits ?? []) {
    const d = new Date(v.starts_at).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(v);
  }
  const hour = new Date().getHours();
  return (
    <div className="app">
      <Nav />
      <main className="page">
        <div className="sub">{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
        <h1>Good {hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening'}, {me.name.split(' ')[0]}</h1>
        {zoho && zoho.state === 'not-configured' && (
          <div className="issue info" style={{ marginTop: 16 }}><span className="ico">i</span><div>Zoho CRM is <b>not connected</b> — visits shown here are the ones created in this app. When Zoho is connected, scheduled appointments assigned to you appear automatically.</div></div>
        )}
        <div className="section-title">Your visits</div>
        {visits === null ? <div className="card">Loading…</div> : visits.length === 0 ? (
          <div className="card"><Empty title="No upcoming visits">Start an estimate from a customer instead. <div style={{ marginTop: 12 }}><Link className="btn primary" to="/customers">Find customer</Link></div></Empty></div>
        ) : [...byDay.entries()].map(([day, list]) => (
          <div key={day}>
            <div className="section-title" style={{ marginTop: 18 }}>{day}</div>
            <div className="group">
              {list.map((v) => (
                <div className="item" key={v.id} style={{ alignItems: 'flex-start' }}>
                  <div style={{ width: 74, flex: 'none' }}><b>{new Date(v.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</b></div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Link to={`/customers/${v.customer_id}`} style={{ color: 'var(--text)', fontWeight: 600 }}>{v.customer_name}</Link>
                    <div className="sub">{v.address ?? v.customer_address ?? 'No address'}</div>
                    {v.notes && <div className="small" style={{ marginTop: 4 }}>{v.notes}</div>}
                    <div className="row" style={{ gap: 6, marginTop: 6 }}>
                      {me.role !== 'salesman' && v.salesman_name && <span className="pill">{v.salesman_name}</span>}
                      {v.zoho_deal_id && <span className="pill blue">Zoho deal {v.zoho_deal_id}</span>}
                      {v.stage && <span className="pill">{v.stage}</span>}
                    </div>
                  </div>
                  <button className="btn primary small" onClick={() => start(v)}>{v.estimate_id ? 'Resume' : 'Start estimate'}</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </main>
    </div>
  );
}
