import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { Nav, useMe } from '../components/Shell';
import { api, ApiError, money, session, uid } from '../lib/api';
import { Field, Sheet, useToast } from '../components/ui';
import { ProposalBody } from './PublicProposal';

export function ProposalScreen() {
  const { id } = useParams();
  const me = useMe();
  const nav = useNavigate();
  const toast = useToast();
  const [p, setP] = useState<any>(null);
  const [qr, setQr] = useState<string>();
  const [to, setTo] = useState('');
  const [sending, setSending] = useState(false);
  const sendKey = useRef<string>(uid());
  const [approve, setApprove] = useState(false);
  const [appr, setAppr] = useState<any>({});
  const [est, setEst] = useState<any>(null);
  const load = () => api(`/api/proposals/${id}`).then((x) => { setP(x); return x; });
  useEffect(() => { load().then((x) => api(`/api/estimates/${x.estimate_id}`).then((e) => { setEst(e); setTo((t) => t || e.customer?.email || ''); })).catch((e) => toast(e.message)); }, [id]);
  const link = p ? `${location.origin}/p/${p.token}` : '';
  useEffect(() => { if (link) QRCode.toDataURL(link, { width: 480, margin: 1 }).then(setQr); }, [link]);
  if (!p) return <div className="app"><Nav back="/" title="Proposal" /><main className="page">Loading…</main></div>;

  const send = async () => {
    setSending(true);
    try {
      const r = await api(`/api/proposals/${id}/send`, { body: { to, idempotencyKey: sendKey.current } });
      toast(r.status === 'accepted' ? `Accepted by the mail server for ${to}` : `Status: ${r.status}`);
      sendKey.current = uid(); // a later tap is a deliberate resend
      await load();
    } catch (e) {
      toast(e instanceof ApiError && e.body?.code === 'not-configured' ? 'Email is not connected — nothing was sent. Show the QR code instead.' : (e as Error).message);
      sendKey.current = uid();
      await load();
    } finally { setSending(false); }
  };
  const pdf = async () => {
    const r = await fetch(`/api/proposals/${id}/pdf`, { headers: { Authorization: `Bearer ${session.token}` } });
    const b = await r.blob();
    window.open(URL.createObjectURL(b), '_blank');
  };
  const toContract = async () => {
    try { const r = await api(`/api/proposals/${id}/contract`, { body: {} }); nav(`/contracts/${r.id}`); }
    catch (e) { toast((e as Error).message); }
  };
  const recordApproval = async () => {
    try { await api(`/api/proposals/${id}/record-approval`, { body: appr }); setApprove(false); await load(); }
    catch (e) { toast((e as Error).message); }
  };
  const contract = est?.contracts?.find((c: any) => c.proposal_id === p.id);

  return (
    <div className="app">
      <Nav back={`/estimates/${p.estimate_id}`} title={`Proposal v${p.version}`} right={<span className={`pill ${p.status === 'approved' ? 'green' : p.status === 'sent' ? 'blue' : ''}`}>{p.status}</span>} />
      <main className="page wide">
        <div className="grid two" style={{ alignItems: 'start' }}>
          <div className="col">
            <div className="card col">
              <h2>Send from the visit</h2>
              <Field label="Customer email"><input className="input" type="email" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              <div className="row">
                <button className="btn primary" disabled={sending || !to} onClick={send}>{sending ? 'Sending…' : 'Email proposal'}</button>
                <button className="btn" onClick={pdf}>Open PDF</button>
                <button className="btn" onClick={() => { void navigator.clipboard?.writeText(link); toast('Link copied'); }}>Copy link</button>
              </div>
              <div className="small">Status shown is the provider's real response. Retrying the same tap never sends twice.</div>
              {p.deliveries.length > 0 && (
                <table className="t">
                  <thead><tr><th>When</th><th>To</th><th>Status</th></tr></thead>
                  <tbody>{p.deliveries.map((d: any) => <tr key={d.id}><td>{new Date(d.created_at).toLocaleString()}</td><td>{d.recipient}</td><td><span className={`pill ${d.status === 'accepted' ? 'green' : d.status === 'failed' || d.status === 'not-sent' ? 'red' : ''}`}>{d.status === 'accepted' ? 'Accepted by mail server' : d.status}</span>{d.error && <div className="small">{d.error}</div>}</td></tr>)}</tbody>
                </table>
              )}
            </div>
            <div className="card col" style={{ alignItems: 'center', textAlign: 'center' }}>
              <h2>Show this QR code</h2>
              {qr && <img src={qr} alt="QR code for the customer proposal" style={{ width: 'min(320px, 80%)', borderRadius: 16, background: '#fff', padding: 8 }} />}
              <div className="small">Opens only this proposal — no internal costs, notes or other customers. Viewing does not start follow-ups.</div>
              <div className="small">{p.view_count} customer view{p.view_count === 1 ? '' : 's'}</div>
            </div>
            <div className="card col">
              <h2>Approval & contract</h2>
              {p.status === 'approved' ? <div className="issue info"><span className="ico" style={{ color: 'var(--green)' }}>✓</span>Approved by {p.approved_name} on {new Date(p.approved_at).toLocaleString()} — option “{p.public.alternatives.find((a: any) => a.id === p.approved_alternative)?.name}”. Approval is not a signed contract.</div>
                : <div className="small">The customer can approve from their link. A manager can also record an approval received another way.</div>}
              <div className="row">
                {p.status !== 'approved' && me.role !== 'salesman' && <button className="btn" onClick={() => { setAppr({ alternativeId: p.public.alternatives[0]?.id }); setApprove(true); }}>Record approval…</button>}
                {contract ? <button className="btn primary" onClick={() => nav(`/contracts/${contract.id}`)}>Open contract ({contract.status})</button>
                  : <button className="btn primary" disabled={p.status !== 'approved'} onClick={toContract}>Convert to contract</button>}
              </div>
            </div>
            {me.role !== 'salesman' && (
              <div className="card col">
                <h3>Internal snapshot</h3>
                {p.public.alternatives.map((a: any) => {
                  const t = p.internal.totals[a.id];
                  return <div key={a.id} className="row"><span style={{ flex: 1 }}>{a.name}</span><span className="small">cost {money(t.materialCost + t.laborCost)}</span><b>{money(t.total)}</b><span className="pill">{t.marginPct?.toFixed(1)}% margin</span></div>;
                })}
                <div className="small mono">{p.public.frozen.engineVersion} · {p.public.frozen.catalogVersion} · {p.public.frozen.rulesVersion}</div>
              </div>
            )}
          </div>
          <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ padding: '10px 16px', borderBottom: '0.5px solid var(--sep)' }} className="small">Customer view preview</div>
            <ProposalBody s={p.public} token={p.token} preview />
          </div>
        </div>
      </main>
      <Sheet open={approve} onClose={() => setApprove(false)} title="Record customer approval" footer={<><button className="btn" onClick={() => setApprove(false)}>Cancel</button><button className="btn primary" onClick={recordApproval}>Record</button></>}>
        <div className="grid two">
          <Field label="Customer name"><input className="input" value={appr.name ?? ''} onChange={(e) => setAppr({ ...appr, name: e.target.value })} /></Field>
          <Field label="Option"><select className="input" value={appr.alternativeId} onChange={(e) => setAppr({ ...appr, alternativeId: e.target.value })}>{p.public.alternatives.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        </div>
        <Field label="Evidence (required)"><input className="input" value={appr.evidence ?? ''} onChange={(e) => setAppr({ ...appr, evidence: e.target.value })} placeholder="e.g. signed paper proposal, email reply dated…" /></Field>
      </Sheet>
    </div>
  );
}
