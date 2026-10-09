import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { StepProps } from '../Estimate';
import type { PricedLine } from '../../../engine/pricing';
import { isComplete } from '../../../engine/estimate';
import { Field, IssueList, NumberInput, Sheet, useToast } from '../../components/ui';
import { api, ApiError, money, uid } from '../../lib/api';
import { OverrideSheet } from './Technical';
import { useMe } from '../../components/Shell';
import { railingSystems } from '../../lib/catalogView';

export function Review(p: StepProps) {
  const { doc, update, result, meta, estimateId, refData } = p;
  const me = useMe();
  const nav = useNavigate();
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [ovr, setOvr] = useState<PricedLine | null>(null);
  const [create, setCreate] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const [rec, setRec] = useState<string | undefined>();
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<any[] | null>(null);
  const internal = me.role !== 'salesman';
  const systems = railingSystems(refData.catalog);

  const makeProposal = async () => {
    setBusy(true);
    try {
      await p.refreshMeta();
      const r = await api(`/api/estimates/${estimateId}/proposals`, { body: { alternativeIds: sel, recommendedId: rec, photoIds: photos } });
      nav(`/proposals/${r.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.body?.blockers) setBlockers(e.body.blockers);
      else toast((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid">
        <div className="card"><div className="small">Deck area</div><div className="price-big" style={{ fontSize: 26 }}>{result.area.effectiveSqFt.toFixed(1)} sq ft</div>{result.area.override && <div className="small">Calculated {result.area.computedSqFt.toFixed(1)} · override: {result.area.override.reason}</div>}</div>
        <div className="card"><div className="small">Perimeter</div><div className="price-big" style={{ fontSize: 26 }}>{result.perimeterFt.toFixed(1)} ft</div></div>
        <div className="card"><div className="small">Structure</div><div className="price-big" style={{ fontSize: 22 }}>{result.framing?.structuralVerified ? '✓ Verified' : 'Needs review'}</div><div className="small">Rules: {result.rulesVersion}</div></div>
        <div className="card"><div className="small">Snapshot</div><div className="mono">{result.engineVersion}<br />{result.catalogVersion}</div></div>
      </div>

      {result.alternatives.length === 0 && <div className="issue blocker"><span className="ico">!</span>No product options yet — choose products in the consultation.</div>}

      {result.alternatives.map((a) => {
        const c = isComplete(result, a.alternative.id);
        const groups = [...new Set(a.lines.map((l) => l.group))];
        return (
          <div key={a.alternative.id} className="card col">
            <div className="row">
              <h2 style={{ flex: 1, margin: 0 }}>{a.alternative.name}</h2>
              {c.complete ? <span className="pill green">Complete</span> : <span className="pill orange">{c.blockers.length} open item{c.blockers.length === 1 ? '' : 's'}</span>}
            </div>
            {doc.consult.railing.wanted && systems.length > 0 && (
              <div className="row">
                <span className="small">Railing for this option</span>
                <select className="input" style={{ maxWidth: 260 }} value={a.alternative.railingSystem ?? ''} onChange={(e) => update((d) => { d.alternatives.find((x) => x.id === a.alternative.id)!.railingSystem = e.target.value || undefined; })}>
                  <option value="">None</option>{systems.map((s) => <option key={s.name}>{s.name}</option>)}
                </select>
                <select className="input" style={{ maxWidth: 200 }} value={a.alternative.railingColor ?? ''} onChange={(e) => update((d) => { d.alternatives.find((x) => x.id === a.alternative.id)!.railingColor = e.target.value || undefined; })}>
                  <option value="">Color…</option>{systems.find((s) => s.name === a.alternative.railingSystem)?.colors.map((col) => <option key={col}>{col}</option>)}
                </select>
              </div>
            )}
            <div className="grid">
              <Stat label="Materials" value={money(a.totals.materialSell)} sub={internal ? `cost ${money(a.totals.materialCost)}` : undefined} />
              <Stat label="Labor" value={money(a.totals.laborSell)} sub={internal ? `cost ${money(a.totals.laborCost)}` : undefined} />
              <Stat label="Allowances" value={money(a.totals.allowances)} />
              {a.totals.discount > 0 && <Stat label="Discount" value={`−${money(a.totals.discount)}`} />}
              <Stat label="Tax" value={a.totals.tax === null ? 'Not configured' : money(a.totals.tax)} />
              <Stat label="Customer total" value={a.totals.total === null ? 'Incomplete' : money(a.totals.total)} strong />
              {a.totals.projectMarkup > 0 && <Stat label="Project markup" value={money(a.totals.projectMarkup)} sub="Pricing policy" />}
              {internal && a.totals.commission > 0 && <Stat label="Commission" value={money(a.totals.commission)} sub="Internal only" />}
              {internal && <Stat label="Margin / markup" value={a.totals.marginPct === null ? '—' : `${a.totals.marginPct.toFixed(1)}% / ${a.totals.markupPct?.toFixed(1)}%`} sub="Internal only" />}
            </div>
            {a.totals.needsPricing.length > 0 && <div className="small">Missing prices are listed as "needs pricing" and are never counted as $0.</div>}
            <IssueList issues={a.issues.filter((i) => i.severity !== 'info')} empty="No open items for this option." />
            <div className="scroll-x">
              <table className="t">
                <thead><tr><th>Item</th><th className="num">Calc</th><th className="num">Buy</th><th>Unit</th>{internal && <th className="num">Unit cost</th>}<th className="num">Price</th><th /></tr></thead>
                <tbody>
                  {groups.map((g) => [
                    <tr key={g}><td colSpan={7} style={{ fontWeight: 700, paddingTop: 16 }}>{g}</td></tr>,
                    ...a.lines.filter((l) => l.group === g).map((l) => (
                      <tr key={l.key}>
                        <td>
                          <div>{l.description} {l.status !== 'ok' && <span className={`pill ${l.status === 'needs-pricing' || l.status === 'needs-product' ? 'red' : 'orange'}`}>{l.status.replace('-', ' ')}</span>}</div>
                          <div className="small">{l.sku ?? ''}</div>
                          {open === `${a.alternative.id}:${l.key}` && (
                            <div className="trace">
                              <div><b>Formula:</b> {l.formula}</div>
                              {Object.entries(l.inputs).map(([k, v]) => <div key={k}>{k}: {String(v)}</div>)}
                              {l.ruleRef && <div>Rule: {l.ruleRef}</div>}
                              {l.rounding && <div>Rounding: {l.rounding}</div>}
                              <div>Source: {l.sourceVersion}</div>
                              {Array.isArray(l.detail) && l.detail.length > 0 && typeof l.detail[0] === 'object' && 'board' in (l.detail[0] as object) && <div>Boards: {(l.detail as any[]).map((b) => `#${b.board}[${b.cuts.join(', ')}; offcut ${b.remainderIn}"]`).join('  ')}</div>}
                              {l.override && <div style={{ color: 'var(--orange)' }}>Override by {l.override.by}: {l.purchaseQty} → {l.override.value} — {l.override.reason}</div>}
                            </div>
                          )}
                        </td>
                        <td className="num">{round(l.calcQty)}</td>
                        <td className="num">{l.override ? <><s className="small">{l.purchaseQty}</s> <b>{l.effectiveQty}</b></> : l.purchaseQty}</td>
                        <td>{l.unit}</td>
                        {internal && <td className="num">{l.unitCost !== undefined ? money(l.unitCost) : '—'}</td>}
                        <td className="num">{l.extSell !== undefined ? money(l.extSell) : '—'}</td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn small ghost" onClick={() => setOpen(open === `${a.alternative.id}:${l.key}` ? null : `${a.alternative.id}:${l.key}`)}>Why?</button>
                          {l.kind !== 'allowance' && <button className="btn small ghost" onClick={() => setOvr(l)}>Adjust</button>}
                        </td>
                      </tr>
                    )),
                  ])}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      <IssueList issues={result.issues.filter((i) => i.severity !== 'info')} />

      <CustomLines {...p} />

      <div className="card col">
        <div className="row"><h3 style={{ flex: 1, margin: 0 }}>Material list</h3>
          {result.alternatives.map((a) => <button key={a.alternative.id} className="btn small" onClick={() => downloadCsv(a, internal, result.catalogVersion)}>CSV — {a.alternative.name.slice(0, 28)}</button>)}
        </div>
        <div className="small">SKU, quantities (calculated and ordered), waste, unit, {internal ? 'cost, ' : ''}selling price and the price-book version used. Generated from this exact revision.</div>
      </div>

      <div className="card col">
        <h3>Discount</h3>
        <div className="small">Salesmen up to {refData.settings?.discounts?.salesmanMaxPct ?? 0}% · managers up to {refData.settings?.discounts?.managerMaxPct ?? 0}%. Price overrides are manager/admin only.</div>
        <div className="grid">
          <Field label="Discount %"><NumberInput value={doc.pricing.discountPct} unit="%" onChange={(v) => update((d) => { d.pricing.discountPct = v; })} /></Field>
          <Field label="Reason"><input className="input" value={doc.pricing.discountReason ?? ''} onChange={(e) => update((d) => { d.pricing.discountReason = e.target.value; })} /></Field>
        </div>
      </div>

      <div className="card col">
        <div className="row"><h3 style={{ flex: 1, margin: 0 }}>Proposal</h3><button className="btn primary" disabled={!result.alternatives.length} onClick={() => { setSel(result.alternatives.map((a) => a.alternative.id)); setRec(result.alternatives[0]?.alternative.id); setCreate(true); }}>Create proposal</button></div>
        <div className="small">Creating a proposal locks today's prices, catalog version and rules into a snapshot. Later catalog changes never alter it.</div>
        {(meta?.proposals ?? []).map((pp: any) => (
          <Link key={pp.id} to={`/proposals/${pp.id}`} className="item chev" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '10px 0', color: 'var(--text)' }}>
            <b>Proposal v{pp.version}</b><span className="pill">{pp.status}</span>{pp.sent_at && <span className="small">sent {new Date(pp.sent_at).toLocaleDateString()}</span>}<span className="small">{pp.view_count} views</span>
          </Link>
        ))}
      </div>

      {ovr && <OverrideSheet open title={`Adjust quantity — ${ovr.description}`} unit={ovr.unit} computed={ovr.purchaseQty} current={doc.overrides[ovr.key]} onClose={() => setOvr(null)} onSave={(o) => { update((d) => { if (o) d.overrides[ovr.key] = o; else delete d.overrides[ovr.key]; }); setOvr(null); }} />}

      <Sheet open={create} onClose={() => setCreate(false)} title="Create proposal" footer={<><button className="btn" onClick={() => setCreate(false)}>Cancel</button><button className="btn primary" disabled={!sel.length || busy} onClick={makeProposal}>{busy ? 'Checking…' : 'Create'}</button></>}>
        <div className="label">Options to include</div>
        <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)', marginBottom: 12 }}>
          {result.alternatives.map((a) => (
            <label key={a.alternative.id} className="item">
              <input type="checkbox" checked={sel.includes(a.alternative.id)} onChange={(e) => setSel(e.target.checked ? [...sel, a.alternative.id] : sel.filter((x) => x !== a.alternative.id))} />
              <span style={{ flex: 1 }}>{a.alternative.name}</span>
              <label className="small"><input type="radio" name="rec" checked={rec === a.alternative.id} onChange={() => setRec(a.alternative.id)} /> Recommended</label>
            </label>
          ))}
        </div>
        {(meta?.photos ?? []).length > 0 && <>
          <div className="label">Photos to include</div>
          <div className="row" style={{ marginBottom: 12 }}>{meta.photos.map((ph: any) => <label key={ph.id} className="pill"><input type="checkbox" checked={photos.includes(ph.id)} onChange={(e) => setPhotos(e.target.checked ? [...photos, ph.id] : photos.filter((x) => x !== ph.id))} /> {ph.caption || ph.original_name}</label>)}</div>
        </>}
        {blockers && <><div className="label">Resolve before creating the proposal</div><IssueList issues={blockers} /></>}
      </Sheet>
    </div>
  );
}

function Stat({ label, value, sub, strong }: { label: string; value: string; sub?: string; strong?: boolean }) {
  return <div className="card flat"><div className="small">{label}</div><div style={{ fontSize: strong ? 24 : 19, fontWeight: 700 }}>{value}</div>{sub && <div className="small">{sub}</div>}</div>;
}
const round = (x: number) => Math.round(x * 100) / 100;

function downloadCsv(a: any, internal: boolean, catalogVersion: string) {
  const esc = (v: unknown) => { const t = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const head = ['Group', 'SKU', 'Description', 'Calculated qty', 'Order qty', 'Unit', 'Waste %', ...(internal ? ['Unit cost', 'Ext cost'] : []), 'Unit price', 'Ext price', 'Formula', 'Source'];
  const rows = a.lines.filter((l: any) => !l.inputs?.internalOnly || internal).map((l: any) => [l.group, l.sku, l.description, l.calcQty, l.effectiveQty, l.unit, l.wastePct ?? '', ...(internal ? [l.unitCost ?? '', l.extCost ?? ''] : []), l.unitSell ?? '', l.extSell ?? '', l.formula, l.sourceVersion ?? catalogVersion]);
  const csv = [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const el = document.createElement('a');
  el.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  el.download = `material-list-${a.alternative.name.replace(/[^\w]+/g, '-').toLowerCase()}.csv`;
  el.click();
}

function CustomLines({ doc, update, refData, result, readOnly }: StepProps) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [f, setF] = useState<any>({ qty: 1, reason: '' });
  const lines = doc.customLines ?? [];
  const hits = q.length < 2 ? [] : refData.catalog.filter((c) => c.active && `${c.sku} ${c.description}`.toLowerCase().includes(q.toLowerCase())).slice(0, 12);
  const pick = (c: any) => setF({ ...f, catalogId: c.id, description: c.description, unit: c.category === 'labor' ? c.labor?.unit ?? 'each' : c.purchaseUnit, unitPrice: undefined });
  const add = () => { update((d) => { d.customLines = [...(d.customLines ?? []), { id: uid().slice(0, 8), catalogId: f.catalogId, description: f.description, qty: Number(f.qty), unit: f.unit || 'each', unitPrice: f.catalogId ? undefined : f.unitPrice, unitCost: f.catalogId ? undefined : f.unitCost, reason: f.reason, internalOnly: !!f.internalOnly, alternativeIds: f.altId ? [f.altId] : undefined }]; }); setOpen(false); setF({ qty: 1, reason: '' }); setQ(''); };
  return (
    <div className="card col">
      <div className="row"><h3 style={{ flex: 1, margin: 0 }}>Added items</h3>{!readOnly && <button className="btn small primary" onClick={() => setOpen(true)}>＋ Add item</button>}</div>
      <div className="small">For price-book items the calculator doesn't place automatically — joist tape, drainage, lattice, dumpsters, delivery, landings — or a custom line (managers only).</div>
      {lines.map((l) => (
        <div key={l.id} className="row">
          <span style={{ flex: 1 }}>{l.description} <span className="small">— {l.qty} {l.unit}{l.alternativeIds ? ' · one option only' : ''}{l.internalOnly ? ' · internal' : ''} · {l.reason}</span></span>
          {!readOnly && <button className="btn small danger" onClick={() => update((d) => { d.customLines = (d.customLines ?? []).filter((x) => x.id !== l.id); })}>Remove</button>}
        </div>
      ))}
      <Sheet open={open} onClose={() => setOpen(false)} title="Add item" footer={<><button className="btn" onClick={() => setOpen(false)}>Cancel</button><button className="btn primary" disabled={!f.description || !(Number(f.qty) > 0) || !f.reason?.trim() || (!f.catalogId && f.unitPrice === undefined)} onClick={add}>Add</button></>}>
        <Field label="Search the price book"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. joist tape, dumpster, RainEscape" /></Field>
        <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)', margin: '8px 0' }}>{hits.map((c) => <button key={c.id} className="item" onClick={() => pick(c)} style={{ background: f.catalogId === c.id ? 'var(--accent-soft)' : undefined }}><span style={{ flex: 1 }}>{c.description}<div className="small">{c.sku} · {c.category}</div></span><span className="small">{c.sale?.price !== undefined ? money(c.sale.price) : ''}</span></button>)}</div>
        {me.role !== 'salesman' && !f.catalogId && <div className="grid two">
          <Field label="…or a custom description"><input className="input" value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value, catalogId: undefined })} /></Field>
          <Field label="Unit price (sell)"><NumberInput value={f.unitPrice} unit="$" onChange={(v) => setF({ ...f, unitPrice: v })} /></Field>
          <Field label="Unit cost (internal)"><NumberInput value={f.unitCost} unit="$" onChange={(v) => setF({ ...f, unitCost: v })} /></Field>
          <Field label="Unit"><input className="input" value={f.unit ?? 'each'} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
        </div>}
        <div className="grid two">
          <Field label="Quantity"><NumberInput value={f.qty} onChange={(v) => setF({ ...f, qty: v })} /></Field>
          <Field label="Reason (required)"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="e.g. tape all joists" /></Field>
          <Field label="Applies to"><select className="input" value={f.altId ?? ''} onChange={(e) => setF({ ...f, altId: e.target.value || undefined })}><option value="">All options</option>{result.alternatives.map((a) => <option key={a.alternative.id} value={a.alternative.id}>{a.alternative.name}</option>)}</select></Field>
        </div>
      </Sheet>
    </div>
  );
}
