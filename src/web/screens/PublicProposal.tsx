import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, money } from '../lib/api';
import { Field } from '../components/ui';

export function PublicProposal() {
  const { token = '' } = useParams();
  const [s, setS] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/public/p/${token}`).then(setS).catch((e) => setErr(e.message)); }, [token]);
  if (err) return <div className="empty"><h2>Proposal not found</h2><p>This link may be mistyped. Please contact us.</p></div>;
  if (!s) return <div className="empty">Loading…</div>;
  return <div style={{ maxWidth: 980, margin: '0 auto' }}><ProposalBody s={s} token={token} onApproved={() => api(`/api/public/p/${token}`).then(setS)} /></div>;
}

export function ProposalBody({ s, token, preview, onApproved }: { s: any; token: string; preview?: boolean; onApproved?: () => void }) {
  const [choice, setChoice] = useState<string | undefined>(s.recommendedAlternativeId ?? s.alternatives[0]?.id);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState('');
  const approve = async () => {
    try { const r = await api(`/api/public/p/${token}/approve`, { body: { name, alternativeId: choice } }); setMsg(r.note); onApproved?.(); }
    catch (e) { setMsg((e as Error).message); }
  };
  const pts = s.project.rings.flatMap((r: any) => r.pts);
  return (
    <div>
      <section className="hero">
        <div className="sub" style={{ fontWeight: 600, color: 'var(--brand)' }}>{s.company.name}</div>
        <h1>Your new deck, {s.customer.name.split(' ')[0]}</h1>
        <p className="sub">{s.customer.address} · Proposal v{s.proposalVersion} · {new Date(s.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
      </section>
      <div style={{ padding: '0 16px 40px' }} className="col">
        {pts.length > 0 && (
          <div className="card" style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 16, alignItems: 'center' }}>
            <Sketch rings={s.project.rings} />
            <div className="col" style={{ gap: 4, minWidth: 140 }}>
              <div className="small">Deck area</div><div className="price-big" style={{ fontSize: 26 }}>{s.project.areaSqFt} sq ft</div>
              {s.project.stairs > 0 && <div className="small">{s.project.stairs} stair{s.project.stairs > 1 ? 's' : ''}</div>}
              {s.project.gates > 0 && <div className="small">{s.project.gates} gate{s.project.gates > 1 ? 's' : ''}</div>}
            </div>
          </div>
        )}
        <h2 style={{ marginTop: 18 }}>Your options</h2>
        <div className="compare">
          {s.alternatives.map((a: any) => (
            <div key={a.id} className={`card col ${a.id === s.recommendedAlternativeId ? 'recommended' : ''}`} onClick={() => setChoice(a.id)} style={{ cursor: 'pointer', outline: choice === a.id ? '3px solid var(--accent)' : undefined }}>
              {a.id === s.recommendedAlternativeId && <span className="pill" style={{ alignSelf: 'flex-start', background: 'rgba(201,138,11,.15)', color: 'var(--brand)' }}>Recommended</span>}
              <h3>{a.name}</h3>
              <div className="small">{a.kind === 'wood' ? 'Wood' : 'Composite'}</div>
              <div className="price-big">{money(a.price.total)}</div>
              <div className="small">incl. tax {money(a.price.tax)}{a.price.discount ? ` · discount −${money(a.price.discount)}` : ''}</div>
              <hr className="sep" />
              {a.decking && <div><b>Decking</b> · {a.decking}</div>}
              {a.fascia && <div><b>Fascia</b> · {a.fascia}</div>}
              {a.railing && <div><b>Railing</b> · {a.railing}</div>}
              {a.allowances.map((x: any) => <div key={x.label} className="small">Allowance: {x.label} {money(x.amount)}</div>)}
              <details><summary className="small" style={{ cursor: 'pointer' }}>What's included</summary>
                {a.scope.map((g: any) => <div key={g.group} style={{ marginTop: 8 }}><b className="small">{g.group}</b>{g.items.map((i: any, k: number) => <div key={k} className="small">• {i.description} — {i.qty} {i.unit}</div>)}</div>)}
              </details>
            </div>
          ))}
        </div>
        <h2 style={{ marginTop: 18 }}>Your selections</h2>
        <div className="group">{s.selections.map((x: any) => <div className="item" key={x.label}><span style={{ flex: 1 }} className="sub">{x.label}</span><span>{x.value}</span></div>)}</div>
        {s.photos.length > 0 && <><h2 style={{ marginTop: 18 }}>Photos</h2><div className="grid">{s.photos.map((ph: any) => <figure key={ph.id} style={{ margin: 0 }}><img src={`/api/public/p/${token}/photos/${ph.id}`} alt={ph.caption ?? ''} style={{ width: '100%', borderRadius: 14, aspectRatio: '4/3', objectFit: 'cover' }} /><figcaption className="small">{ph.caption}</figcaption></figure>)}</div></>}
        {s.exclusions.length > 0 && <><h2 style={{ marginTop: 18 }}>Not included</h2><div className="card">{s.exclusions.map((e: string) => <div key={e}>• {e}</div>)}</div></>}
        {s.terms && <><h2 style={{ marginTop: 18 }}>Terms</h2><div className="card" style={{ whiteSpace: 'pre-wrap' }}>{s.terms}</div></>}
        <div className="card col" style={{ marginTop: 18 }}>
          {s.status === 'approved' ? <div><h2>Approved ✓</h2><div className="sub">Approved by {s.approvedName}. We'll prepare your contract for signature.</div></div> : preview ? <div className="small">Customers can approve their chosen option here.</div> : <>
            <h2>Ready to go?</h2>
            <div className="sub">Choose an option above, type your name, and tap approve. Approval lets us prepare your contract; it is not the signed contract.</div>
            <div className="row"><Field label="Your full name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
            <button className="btn primary" disabled={!choice || name.trim().length < 2} onClick={approve}>Approve {s.alternatives.find((a: any) => a.id === choice)?.name}</button>
            {msg && <div className="small">{msg}</div>}
          </>}
          <a className="btn" href={`/api/public/p/${token}/pdf`} target="_blank" rel="noreferrer">Download PDF</a>
        </div>
        <div className="small" style={{ textAlign: 'center', marginTop: 20 }}>{[s.company.phone, s.company.email, s.company.website].filter(Boolean).join(' · ')}</div>
      </div>
    </div>
  );
}

function Sketch({ rings }: { rings: { hole: boolean; pts: { x: number; y: number }[] }[] }) {
  const pts = rings.flatMap((r) => r.pts);
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
  const W = 400, H = 240, pad = 16;
  const k = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
  const d = rings.map((r) => r.pts.map((p, i) => `${i ? 'L' : 'M'}${pad + (p.x - minX) * k},${H - pad - (p.y - minY) * k}`).join(' ') + 'Z').join(' ');
  return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%' }}><path d={d} fill="rgba(201,138,11,0.18)" stroke="var(--brand)" strokeWidth={2} fillRule="evenodd" /></svg>;
}
