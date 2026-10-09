import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Nav } from '../components/Shell';
import { api } from '../lib/api';
import { Empty, useToast } from '../components/ui';

const STATUS: Record<string, [string, string]> = {
  draft: ['', 'Draft'], review: ['orange', 'In review'], sent: ['blue', 'Sent'], approved: ['green', 'Approved'], contracted: ['green', 'Contract signed'],
};

export function CustomerDetail() {
  const { id } = useParams();
  const [d, setD] = useState<any>(null);
  const nav = useNavigate();
  const toast = useToast();
  useEffect(() => { api(`/api/customers/${id}`).then(setD).catch((e) => toast(e.message)); }, [id]);
  if (!d) return <div className="app"><Nav back="/customers" title="Customer" /><main className="page">Loading…</main></div>;
  const c = d.customer;
  const newEstimate = async (title = 'Deck estimate') => {
    try {
      const r = await api('/api/estimates', { body: { customerId: c.id, title, dealId: d.deals[0]?.id, appointmentId: d.appointments[0]?.id } });
      nav(`/estimates/${r.id}`);
    } catch (e) { toast((e as Error).message); }
  };
  const duplicate = async (eid: string) => {
    try {
      const r = await api(`/api/estimates/${eid}/duplicate`, { body: {} });
      nav(`/estimates/${r.id}`);
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <div className="app">
      <Nav back="/customers" title={c.name} right={<button className="btn primary small" onClick={() => newEstimate()}>＋ New estimate</button>} />
      <main className="page">
        <h1>{c.name}</h1>
        <div className="sub">{[c.address, c.city, c.state, c.zip].filter(Boolean).join(', ')}</div>
        <div className="row" style={{ marginTop: 10 }}>
          {c.phone && <a className="btn small" href={`tel:${c.phone}`}>📞 {c.phone}</a>}
          {c.email && <a className="btn small" href={`mailto:${c.email}`}>✉️ {c.email}</a>}
          {c.zoho_contact_id ? <span className="pill blue">Zoho contact {c.zoho_contact_id}</span> : <span className="pill">Not linked to Zoho</span>}
          {d.deals.map((x: any) => <span key={x.id} className="pill blue">Deal {x.zoho_deal_id ?? x.id}{x.stage ? ` · ${x.stage}` : ''}</span>)}
        </div>

        <div className="section-title">Estimates</div>
        {d.estimates.length === 0 ? <div className="card"><Empty title="No estimates yet"><button className="btn primary" onClick={() => newEstimate()}>Start the consultation</button></Empty></div> : (
          <div className="group">
            {d.estimates.map((e: any) => {
              const [tone, label] = STATUS[e.status] ?? ['', e.status];
              return (
                <div key={e.id} className="item">
                  <Link to={`/estimates/${e.id}`} style={{ flex: 1, color: 'var(--text)', minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{e.title}</div>
                    <div className="sub">Rev {e.rev_number} of {e.revision_count} · {e.salesman_name ?? 'Unassigned'} · updated {new Date(e.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</div>
                  </Link>
                  {e.proposal_version && <span className="pill">Proposal v{e.proposal_version}</span>}
                  <span className={`pill ${tone}`}>{label}</span>
                  <button className="btn small" onClick={() => duplicate(e.id)} title="Duplicate as a new alternative estimate">Duplicate</button>
                  <Link className="btn small primary" to={`/estimates/${e.id}`}>{e.status === 'draft' ? 'Resume' : 'Open'}</Link>
                </div>
              );
            })}
          </div>
        )}

        <div className="section-title">Appointments</div>
        {d.appointments.length === 0 ? <div className="card small">No appointments recorded.</div> : (
          <div className="group">
            {d.appointments.map((a: any) => (
              <div key={a.id} className="item">
                <div style={{ flex: 1 }}><b>{new Date(a.starts_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</b><div className="sub">{a.salesman_name} · {a.address ?? c.address ?? ''}</div>{a.notes && <div className="small">{a.notes}</div>}</div>
                <span className="pill">{a.status}</span>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
