import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Nav, useMe } from '../components/Shell';
import { api } from '../lib/api';
import { Field, useToast } from '../components/ui';

export function ContractScreen() {
  const { id } = useParams();
  const me = useMe();
  const toast = useToast();
  const [c, setC] = useState<any>(null);
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const load = () => api(`/api/contracts/${id}`).then((x) => { setC(x); setBody(x.body); });
  useEffect(() => { load().catch((e) => toast(e.message)); }, [id]);
  if (!c) return <div className="app"><Nav back="/" title="Contract" /><main className="page">Loading…</main></div>;
  const canEdit = me.role !== 'salesman' && ['draft', 'ready'].includes(c.status);
  const act = async (fn: () => Promise<any>, ok?: string) => { try { await fn(); if (ok) toast(ok); await load(); } catch (e) { toast((e as Error).message); } };
  const steps = [['draft', 'Draft'], ['ready', 'Ready for signature'], ['signed', 'Signed']];
  return (
    <div className="app">
      <Nav back={`/estimates/${c.estimate_id}`} title="Contract" right={<span className={`pill ${c.status === 'signed' ? 'green' : 'orange'}`}>{c.status}</span>} />
      <main className="page">
        <div className="row" style={{ marginBottom: 16 }}>{steps.map(([k, l], i) => <span key={k} className={`pill ${steps.findIndex((s) => s[0] === c.status) >= i ? 'blue' : ''}`}>{i + 1}. {l}</span>)}</div>
        {c.missing.length > 0 && <div className="issue review" style={{ marginBottom: 12 }}><span className="ico">?</span>Fill these before it can be sent: {c.missing.join(', ')}. {c.body.includes('[ADMIN:') && 'Also replace the [ADMIN] placeholder with your attorney-approved terms.'}</div>}
        <div className="card col">
          <textarea className="input mono" style={{ minHeight: 520, fontSize: 14, lineHeight: 1.5 }} value={body} readOnly={!canEdit} onChange={(e) => setBody(e.target.value)} />
          {canEdit && body !== c.body && <div className="row"><Field label="Reason for this edit (tracked)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field><button className="btn primary" disabled={!reason.trim()} onClick={() => act(() => api(`/api/contracts/${id}`, { method: 'PATCH', body: { body, reason } }).then(() => setReason('')), 'Edit saved')}>Save edit</button></div>}
          {me.role === 'salesman' && c.status === 'draft' && <div className="small">A manager reviews and edits contracts before they go out.</div>}
        </div>
        <div className="row" style={{ marginTop: 16 }}>
          {c.status === 'draft' && me.role !== 'salesman' && <button className="btn primary" onClick={() => act(() => api(`/api/contracts/${id}/ready`, { method: 'POST' }), 'Marked ready')}>Mark ready for signature</button>}
          {c.status === 'ready' && <button className="btn" onClick={() => act(() => api(`/api/contracts/${id}/send-signature`, { method: 'POST' }))}>Send for e-signature</button>}
          {c.status === 'ready' && me.role !== 'salesman' && <>
            <input ref={file} type="file" accept="application/pdf,image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; const fd = new FormData(); fd.append('file', f); void act(() => api(`/api/contracts/${id}/record-signed`, { form: fd, method: 'POST' }), 'Signed contract recorded'); }} />
            <button className="btn primary" onClick={() => file.current?.click()}>Record signed copy…</button>
          </>}
          <button className="btn ghost" onClick={() => { const w = window.open('', '_blank'); if (w) { w.document.write(`<pre style="font:14px/1.5 -apple-system, sans-serif;white-space:pre-wrap;max-width:760px;margin:40px auto">${c.body.replace(/</g, '&lt;')}</pre>`); w.print(); } }}>Print</button>
        </div>
        {c.status === 'signed' && (
          <div className="card col" style={{ marginTop: 16 }}>
            <h3>Project hand-off</h3>
            <div>Signed {new Date(c.signed_at).toLocaleString()}.</div>
            {c.handoff ? <div className="row"><span className={`pill ${c.handoff.status === 'delivered' ? 'green' : 'orange'}`}>{c.handoff.status === 'held-unconfigured' ? 'Queued — Zoho Projects not connected' : c.handoff.status}</span>{c.handoff.error && <span className="small">{c.handoff.error}</span>}</div> : <div className="small">Preparing…</div>}
            <div className="small">The hand-off package (customer & deal IDs, signed contract, BOM, selections, sketch, photos, notes, permit/HOA) is stored once and delivered when Zoho Projects is connected. Re-recording never creates a second project.</div>
          </div>
        )}
        {c.changes.length > 0 && (
          <div className="card col" style={{ marginTop: 16 }}>
            <h3>Tracked changes</h3>
            {c.changes.map((ch: any, i: number) => <div key={i} className="small">{new Date(ch.at).toLocaleString()} · {ch.by}: {ch.reason}</div>)}
          </div>
        )}
      </main>
    </div>
  );
}
