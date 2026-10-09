import { useEffect, useMemo, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Nav, useMe } from '../components/Shell';
import { api } from '../lib/api';
import { Field, NumberInput, Segmented, Sheet, Toggle, useToast } from '../components/ui';
import { useRefData } from '../lib/refdata';
import { groupsOf, railingSystems, groupLabel } from '../lib/catalogView';

export function Admin() {
  const me = useMe();
  const tabs = [['', 'Integrations'], ['prices', 'Price lists'], ['specs', 'Product specs'], ['catalog', 'Catalog'], ['images', 'Product images'], ['rules', 'Structural rules'], ['packages', 'Packages'], ['settings', 'Settings'], ['template', 'Contract template'], ['users', 'Users']];
  return (
    <div className="app">
      <Nav title="Admin" />
      <main className="page wide">
        <div className="tabs-bar" style={{ marginBottom: 18 }}>{tabs.map(([k, l]) => <NavLink key={k} end to={`/admin/${k}`} className={({ isActive }) => `btn small ${isActive ? 'primary' : ''}`}>{l}</NavLink>)}</div>
        {me.role !== 'admin' && <div className="issue info" style={{ marginBottom: 12 }}><span className="ico">i</span>Managers can view; only admins can change products, prices, rules and templates.</div>}
        <Routes>
          <Route index element={<Integrations />} />
          <Route path="prices" element={<PriceImport />} />
          <Route path="specs" element={<Specs />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="images" element={<Images />} />
          <Route path="rules" element={<Rules />} />
          <Route path="packages" element={<Packages />} />
          <Route path="settings" element={<Settings />} />
          <Route path="template" element={<Template />} />
          <Route path="users" element={<Users />} />
        </Routes>
      </main>
    </div>
  );
}

function Integrations() {
  const [list, setList] = useState<any[]>([]);
  const [ob, setOb] = useState<any>({ events: [], handoffs: [] });
  const toast = useToast();
  const load = () => { api('/api/integrations').then(setList); api('/api/outbox').then(setOb).catch(() => undefined); };
  useEffect(load, []);
  const tone = (s: string) => (s === 'connected' ? 'green' : s === 'configured-untested' ? 'blue' : 'orange');
  const label = (s: string) => (s === 'connected' ? 'Connected' : s === 'configured-untested' ? 'Configured — not yet verified' : 'Not connected');
  return (
    <div className="col">
      <div className="grid two">
        {list.map((i) => (
          <div key={i.key} className="card col">
            <div className="row"><h3 style={{ flex: 1, margin: 0 }}>{i.name}</h3><span className={`pill ${tone(i.state)}`}>{label(i.state)}</span></div>
            <div className="small">{i.detail}</div>
            {i.env.length > 0 && <div className="small">Server environment: {i.env.map((e: string) => <span key={e} className="kbd" style={{ marginRight: 4 }}>{e}</span>)}</div>}
          </div>
        ))}
      </div>
      <div className="section-title">Outbox (events waiting for integrations)</div>
      <div className="row"><button className="btn small" onClick={() => api('/api/outbox/process', { method: 'POST' }).then((r) => { toast(`Delivered ${r.delivered}, held ${r.held}, failed ${r.failed}`); load(); })}>Process now</button></div>
      <div className="card scroll-x">
        <table className="t">
          <thead><tr><th>Event</th><th>Key</th><th>Status</th><th>Detail</th><th>Created</th></tr></thead>
          <tbody>{ob.events.map((e: any) => <tr key={e.id}><td>{e.event_type} v{e.event_version}</td><td className="mono">{e.dedupe_key}</td><td><span className={`pill ${e.status === 'delivered' ? 'green' : e.status === 'failed' ? 'red' : 'orange'}`}>{e.status}</span></td><td className="small">{e.last_error}</td><td className="small">{new Date(e.created_at).toLocaleString()}</td></tr>)}</tbody>
        </table>
        {ob.events.length === 0 && <div className="small">No events yet. EstimateSent is created only after a provider-accepted send.</div>}
      </div>
      {ob.handoffs.length > 0 && <div className="card"><h3>Project hand-offs</h3>{ob.handoffs.map((h: any) => <div key={h.id} className="row"><span className="mono">{h.contract_id}</span><span className="pill orange">{h.status}</span><span className="small">{h.error}</span></div>)}</div>}
    </div>
  );
}

function PriceImport() {
  const ref = useRefData();
  const toast = useToast();
  const [batch, setBatch] = useState<any>(null);
  const [fields, setFields] = useState<any[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [report, setReport] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const loadHistory = () => api('/api/catalog/imports').then(setHistory).catch(() => undefined);
  useEffect(() => { api('/api/catalog/fields').then(setFields).catch(() => undefined); loadHistory(); }, []);
  const upload = async (f: File) => {
    const fd = new FormData();
    fd.append('file', f);
    try { const b = await api('/api/catalog/imports', { form: fd, method: 'POST' }); setBatch(b); setMapping(b.mapping); setReport(null); } catch (e) { toast((e as Error).message); }
  };
  const validate = async () => setReport(await api(`/api/catalog/imports/${batch.id}/mapping`, { method: 'PUT', body: { mapping } }));
  const approve = async () => { try { const r = await api(`/api/catalog/imports/${batch.id}/approve`, { method: 'POST' }); toast(`${r.applied} items applied — catalog ${r.catalogVersion}`); setBatch(null); setReport(null); loadHistory(); ref.reload(); } catch (e) { toast((e as Error).message); } };
  return (
    <div className="col">
      <div className="card col">
        <h2>Import a price list</h2>
        <div className="sub">Upload the supplier or company price list as .csv, .xlsx or .xls. Yellowstone Leap material and labor books are recognized automatically. You'll map its columns, review every row, and approve before anything changes. Missing fields are reported — never filled in with guesses.</div>
        <div className="row">
          <label className="btn primary">Choose file<input type="file" accept=".csv,.xlsx,.xls" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} /></label>
          <a className="btn" href="/api/catalog/import-template.csv" onClick={(e) => { e.preventDefault(); api('/api/catalog/import-template.csv').then((t) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = 'price-list-template.csv'; a.click(); }); }}>Download column template</a>
        </div>
      </div>
      {batch && (
        <div className="card col">
          <h3>{batch.rowCount} rows{batch.sheet ? ` · sheet "${batch.sheet}"` : ''}{mapping.__format ? '' : ' · map columns'}</h3>
          {mapping.__format && <div className="issue info"><span className="ico" style={{ color: 'var(--green)' }}>✓</span><div>Recognized the Yellowstone <b>Leap {mapping.__format === 'leap-labor' ? 'labor' : 'material'} price book</b> format — columns are mapped automatically. Product specs the file doesn't contain (board width, gap, joist spacing, clips per crossing, concrete yield) are reported, not guessed.</div></div>}
          <div className="scroll-x"><table className="t"><thead><tr>{batch.headers.map((h: string) => <th key={h}>{h}</th>)}</tr></thead><tbody>{batch.preview.slice(0, 5).map((r: string[], i: number) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
          {!mapping.__format && <div className="grid">
            {fields.map((f) => (
              <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.hint}>
                <select className="input" value={mapping[f.key] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value })}>
                  <option value="">— not in file —</option>{batch.headers.map((h: string) => <option key={h}>{h}</option>)}
                </select>
              </Field>
            ))}
          </div>}
          <div className="row"><button className="btn primary" onClick={validate}>Validate</button></div>
        </div>
      )}
      {report && (
        <div className="card col">
          <div className="row"><h3 style={{ flex: 1, margin: 0 }}>Validation</h3><span className="pill green">{report.counts.create} new</span><span className="pill blue">{report.counts.update} update</span><span className="pill red">{report.counts.skip} skipped</span><span className="pill orange">{report.counts.warnings} warnings</span></div>
          {report.missingFields.length > 0 && <div className="small">Not present in the file: {report.missingFields.join(', ')}</div>}
          <WarningSummary rows={report.rows} />
          <div className="scroll-x" style={{ maxHeight: 420, overflowY: 'auto' }}>
            <table className="t"><thead><tr><th>Row</th><th>SKU</th><th>Action</th><th>Errors / warnings</th></tr></thead>
              <tbody>{report.rows.filter((r: any) => r.errors.length || r.warnings.length).slice(0, 300).map((r: any) => <tr key={r.row}><td>{r.row}</td><td>{r.sku}</td><td><span className={`pill ${r.action === 'skip' ? 'red' : ''}`}>{r.action}</span></td><td className="small">{[...r.errors.map((e: string) => `✖ ${e}`), ...r.warnings.map((w: string) => `⚠ ${w}`)].join(' · ')}</td></tr>)}</tbody></table>
          </div>
          <div className="row"><button className="btn primary" disabled={!report.counts.create && !report.counts.update} onClick={approve}>Approve and apply {report.counts.create + report.counts.update} items</button></div>
        </div>
      )}
      <div className="section-title">History</div>
      <div className="group">{history.map((h) => <div className="item" key={h.id}><span style={{ flex: 1 }}>{h.filename}</span><span className="small">{new Date(h.created_at).toLocaleString()}</span><span className={`pill ${h.status === 'approved' ? 'green' : h.status === 'rolled-back' ? 'orange' : ''}`}>{h.status}</span>{h.counts && <span className="small">{h.counts.create} new · {h.counts.update} upd</span>}
        {h.status === 'approved' && <button className="btn small danger" onClick={() => { if (confirm(`Roll back "${h.filename}"? Updated items return to their previous values; new items are deactivated.`)) api(`/api/catalog/imports/${h.id}/rollback`, { method: 'POST' }).then((r) => { toast(`Restored ${r.restored}, deactivated ${r.deactivated}`); loadHistory(); ref.reload(); }).catch((e) => toast(e.message)); }}>Roll back</button>}</div>)}{!history.length && <div className="item small">No imports yet.</div>}</div>
    </div>
  );
}

function WarningSummary({ rows }: { rows: any[] }) {
  const counts = new Map<string, number>();
  for (const r of rows) for (const w of [...r.warnings, ...(r.derived ?? []).map((d: string) => `Derived: ${d.replace(/\d+(\.\d+)? ft|"[^"]*"/g, '…')}`)]) counts.set(w, (counts.get(w) ?? 0) + 1);
  if (!counts.size) return null;
  return <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)' }}>{[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([w, n]) => <div className="item small" key={w}><span style={{ flex: 1 }}>{w}</span><span className="pill">{n} rows</span></div>)}</div>;
}

function Specs() {
  const ref = useRefData();
  const me = useMe();
  const toast = useToast();
  const [gaps, setGaps] = useState<any[]>([]);
  const [rules, setRules] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const load = () => { api('/api/catalog/spec-gaps').then(setGaps).catch(() => undefined); api('/api/settings').then((s) => setRules(s.productSpecs ?? [])); };
  useEffect(load, []);
  const save = async (next: any[]) => { try { await api('/api/settings/productSpecs', { method: 'PUT', body: next }); setRules(next); setEdit(null); await ref.reload(); load(); } catch (e) { toast((e as Error).message); } };
  const FIELDS: [string, string][] = [['widthIn', 'Actual board width (in)'], ['gapIn', 'Board gap (in)'], ['maxJoistSpacingIn', 'Max joist spacing (in)'], ['perCrossing', 'Fasteners per joist crossing'], ['yieldCuFt', 'Concrete yield per bag (cu ft)'], ['heightIn', 'Actual board height (in)'], ['maxSpanIn', 'Railing max post spacing (in)'], ['packQty', 'Pack quantity']];
  const label = (m: any) => [m.category, m.brand, m.collection, m.profile, m.skuPrefix].filter(Boolean).join(' · ');
  return (
    <div className="col">
      <div className="sub">Price books list products and prices, not installation specs. Enter each product line's specs once from the manufacturer's installation guide or spec sheet, and record the source. The calculator uses these instead of guessing.</div>
      <div className="section-title">Missing specs ({gaps.length} product lines)</div>
      {gaps.length === 0 ? <div className="card small">Every active product line has the specs the calculator needs.</div> : (
        <div className="group">{gaps.map((g) => (
          <div className="item" key={g.key}>
            <div style={{ flex: 1 }}><b>{[g.brand, g.collection ?? g.skuPrefix, g.profile].filter(Boolean).join(' · ')}</b><div className="small">{g.category} · {g.skus} SKU(s) · missing {g.missing.join(', ')}</div></div>
            {me.role === 'admin' && <button className="btn small primary" onClick={() => setEdit({ id: `spec-${Date.now().toString(36)}`, match: { category: g.category, brand: g.brand, collection: g.collection, profile: g.profile, skuPrefix: g.skuPrefix }, set: {}, source: '' })}>Enter specs</button>}
          </div>
        ))}</div>
      )}
      <div className="section-title">Spec rules ({rules.length})</div>
      <div className="group">{rules.map((r) => (
        <div className="item" key={r.id}>
          <div style={{ flex: 1 }}><b>{label(r.match)}</b><div className="small">{Object.entries(r.set).map(([k, v]) => `${k} ${v}`).join(' · ')} — source: {r.source}{r.enteredBy ? ` · ${r.enteredBy}` : ''}</div></div>
          {me.role === 'admin' && <><button className="btn small" onClick={() => setEdit(r)}>Edit</button><button className="btn small danger" onClick={() => save(rules.filter((x) => x.id !== r.id))}>Delete</button></>}
        </div>
      ))}{!rules.length && <div className="item small">No spec rules yet.</div>}</div>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={`Specs — ${edit ? label(edit.match) : ''}`} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={!edit?.source?.trim() || !Object.values(edit?.set ?? {}).some((v) => v !== undefined)} onClick={() => save([...rules.filter((x) => x.id !== edit.id), { ...edit, enteredBy: me.name }])}>Save</button></>}>
        {edit && <>
          <div className="small" style={{ marginBottom: 10 }}>Applies to every active item matching: {label(edit.match)}. Values in the price book itself always win.</div>
          <div className="grid">{FIELDS.map(([k, l]) => <Field key={k} label={l}><NumberInput value={edit.set[k]} onChange={(v) => setEdit({ ...edit, set: { ...edit.set, [k]: v } })} /></Field>)}</div>
          <Field label="Source (required) — e.g. manufacturer install guide, page, date"><input className="input" value={edit.source} onChange={(e) => setEdit({ ...edit, source: e.target.value })} /></Field>
        </>}
      </Sheet>
    </div>
  );
}

function Catalog() {
  const ref = useRefData();
  const me = useMe();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const items = ref.catalog.filter((i) => `${i.sku} ${i.description} ${i.brand ?? ''} ${i.category}`.toLowerCase().includes(q.toLowerCase()));
  const save = async () => {
    try {
      const body = JSON.parse(edit.json);
      if (edit.id) await api(`/api/catalog/items/${edit.id}`, { method: 'PATCH', body }); else await api('/api/catalog/items', { body });
      setEdit(null); await ref.reload();
    } catch (e) { toast((e as Error).message); }
  };
  return (
    <div className="col">
      <div className="row"><input className="input" style={{ flex: 1 }} placeholder="Search SKU, description, brand, category" value={q} onChange={(e) => setQ(e.target.value)} />{me.role === 'admin' && <button className="btn primary" onClick={() => setEdit({ json: JSON.stringify({ sku: '', description: '', category: 'decking', purchaseUnit: 'each', active: true }, null, 2) })}>＋ Item</button>}</div>
      <div className="small">Catalog version {ref.catalogVersion} · {ref.catalog.length} items · {ref.catalog.filter((i) => i.isDemo).length} demo items (blocked from sending)</div>
      <div className="card scroll-x">
        <table className="t">
          <thead><tr><th>SKU</th><th>Description</th><th>Category</th><th>Brand / group</th><th className="num">Length</th><th className="num">Cost</th><th>Sale rule</th><th /></tr></thead>
          <tbody>{items.slice(0, 500).map((i) => (
            <tr key={i.id} style={{ opacity: i.active ? 1 : 0.45 }}>
              <td className="mono">{i.sku}{i.isDemo && <span className="pill orange" style={{ marginLeft: 4 }}>demo</span>}</td><td>{i.description}</td><td>{i.category}</td><td className="small">{i.group ? groupLabel(i.group) : i.brand ?? i.spec?.railingSystem ?? ''}</td>
              <td className="num">{i.stockLengthIn ? `${i.stockLengthIn / 12}'` : ''}</td><td className="num">{i.cost ?? <span className="pill red">missing</span>}</td>
              <td className="small">{i.sale ? `${i.sale.method} ${i.sale.pct ?? i.sale.price ?? ''}` : <span className="pill red">missing</span>}</td>
              <td>{me.role === 'admin' && <button className="btn small ghost" onClick={() => setEdit({ id: i.id, json: JSON.stringify({ ...i, id: undefined }, null, 2) })}>Edit</button>}</td>
            </tr>
          ))}</tbody>
        </table>
        {!items.length && <div className="empty">No catalog items. Import your price list first.</div>}
      </div>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit item' : 'New item'} footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" onClick={save}>Save (new catalog version)</button></>}>
        <textarea className="input mono" style={{ minHeight: 380 }} value={edit?.json ?? ''} onChange={(e) => setEdit({ ...edit, json: e.target.value })} />
        <div className="small">Fields: sku, description, category, brand, collection, color, group, widthIn, heightIn, stockLengthIn, purchaseUnit, packQty, yieldCuFt, cost, sale {'{method, pct|price}'}, labor {'{unit, rate}'}, spec {'{gapIn, maxJoistSpacingIn, perCrossing, maxSpanIn, railingSystem, colors, per, perQty}'}, effectiveDate, source, active.</div>
      </Sheet>
    </div>
  );
}

function Images() {
  const ref = useRefData();
  const me = useMe();
  const toast = useToast();
  const [form, setForm] = useState<any>({ permissionStatus: 'pending', kind: 'product' });
  const [file, setFile] = useState<File | null>(null);
  const upload = async () => {
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    for (const [k, v] of Object.entries(form)) if (v) fd.append(k, String(v));
    try { await api('/api/assets', { form: fd, method: 'POST' }); setFile(null); setForm({ permissionStatus: 'pending', kind: 'product' }); await ref.reload(); toast('Image added'); } catch (e) { toast((e as Error).message); }
  };
  return (
    <div className="col">
      <div className="card col">
        <h2>Add a product image</h2>
        <div className="sub">Use manufacturer-authorized assets or your own photos. Record where it came from and whether you may use it. Cards without an image show a labeled placeholder — nothing is invented.</div>
        {me.role === 'admin' && <>
          <div className="grid">
            {[['brand', 'Brand'], ['collection', 'Collection / railing system'], ['color', 'Color'], ['style', 'Style'], ['sku', 'SKU (optional)'], ['sourceUrl', 'Source URL'], ['attribution', 'Attribution / credit'], ['retrievedAt', 'Date retrieved']].map(([k, l]) => (
              <Field key={k} label={l}><input className="input" type={k === 'retrievedAt' ? 'date' : 'text'} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></Field>
            ))}
            <Field label="Usage permission"><select className="input" value={form.permissionStatus} onChange={(e) => setForm({ ...form, permissionStatus: e.target.value })}>{['owned', 'licensed', 'manufacturer-authorized', 'pending', 'unknown'].map((v) => <option key={v}>{v}</option>)}</select></Field>
          </div>
          <div className="row"><label className="btn">{file ? file.name : 'Choose image'}<input type="file" accept="image/*" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label><button className="btn primary" disabled={!file} onClick={upload}>Upload</button></div>
        </>}
      </div>
      <div className="grid">
        {ref.assets.map((a) => (
          <div key={a.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
            <img src={`/api/assets/${a.id}/file`} alt="" style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover' }} />
            <div style={{ padding: 12 }}>
              <b>{[a.brand, a.collection, a.color].filter(Boolean).join(' · ') || a.sku}</b>
              <div className="small">{a.permission_status}{a.source_url ? ` · ${a.source_url}` : ''}{a.retrieved_at ? ` · ${a.retrieved_at}` : ''}</div>
              {me.role === 'admin' && <button className="btn small danger" onClick={() => api(`/api/assets/${a.id}`, { method: 'DELETE' }).then(() => ref.reload())}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const EMPTY_RULES = { id: 'KY-LEX-DECK', jurisdiction: 'Lexington-Fayette Urban County, KY', codeEdition: '', source: '', effectiveDate: '', joistSpans: [], beamSpans: [], stairs: null, ledgerFastening: [], guardRequiredAboveIn: null, notes: '' };

function Rules() {
  const me = useMe();
  const toast = useToast();
  const ref = useRefData();
  const [list, setList] = useState<any[]>([]);
  const [json, setJson] = useState('');
  const [reviewer, setReviewer] = useState('');
  const load = () => api('/api/rules').then(setList);
  useEffect(() => { void load(); }, []);
  const create = async () => { try { const body = JSON.parse(json); if (body.stairs === null) delete body.stairs; await api('/api/rules', { body }); setJson(''); await load(); } catch (e) { toast((e as Error).message); } };
  const verify = async (r: any) => { try { await api(`/api/rules/${r.id}/${r.version}/verify`, { method: 'POST', body: { reviewer } }); await load(); await ref.reload(); } catch (e) { toast((e as Error).message); } };
  return (
    <div className="col">
      <div className="issue review"><span className="ico">!</span><div>No structural values ship with this app. Enter span tables, stair limits and ledger fastening only from the current code edition adopted by your jurisdiction and the manufacturers' installation instructions, then have a qualified reviewer verify them. Until a verified set is active, every estimate is flagged "not structurally verified".</div></div>
      <div className="card scroll-x">
        <table className="t"><thead><tr><th>Rule set</th><th>Version</th><th>Status</th><th>Jurisdiction / edition</th><th>Source</th><th>Reviewer</th><th /></tr></thead>
          <tbody>{list.map((r) => <tr key={`${r.id}${r.version}`}><td>{r.id}</td><td>v{r.version}</td><td><span className={`pill ${r.status === 'verified' ? 'green' : 'orange'}`}>{r.status}{r.active ? ' · active' : ''}</span></td><td className="small">{r.data.jurisdiction} · {r.data.codeEdition}</td><td className="small">{r.data.source}</td><td className="small">{r.data.reviewer ?? '—'}</td>
            <td>{me.role === 'admin' && r.status !== 'verified' && <button className="btn small" onClick={() => verify(r)} disabled={!reviewer}>Verify & activate</button>}</td></tr>)}</tbody></table>
        {!list.length && <div className="empty">No rule sets yet.</div>}
      </div>
      {me.role === 'admin' && <>
        <Field label="Reviewer name (required to verify)"><input className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)} /></Field>
        <div className="card col">
          <div className="row"><h3 style={{ flex: 1, margin: 0 }}>New rule-set version (draft)</h3><button className="btn small" onClick={() => setJson(JSON.stringify(list[0]?.data ? { ...list[0].data, status: undefined, reviewer: undefined, reviewedAt: undefined, version: undefined } : EMPTY_RULES, null, 2))}>Start from {list.length ? 'latest' : 'blank'}</button></div>
          <textarea className="input mono" style={{ minHeight: 360 }} value={json} onChange={(e) => setJson(e.target.value)} placeholder="Rule set JSON" />
          <div className="small">joistSpans: [{'{speciesGrade, size, spacingIn, maxSpanIn, maxCantileverIn}'}] · beamSpans: [{'{speciesGrade, size, plies, joistSpanIn, maxPostSpacingIn}'}] · stairs: {'{maxRiserIn, minTreadIn, minWidthIn, maxStringerSpacingIn, guardRequiredAboveIn, handrailRequiredAtRisers}'} · ledgerFastening: [{'{substrate, joistSpanUpToIn, fastener, spacingIn, rows, fastenerSku}'}]</div>
          <button className="btn primary" disabled={!json} onClick={create}>Save draft version</button>
        </div>
      </>}
    </div>
  );
}

function Packages() {
  const ref = useRefData();
  const me = useMe();
  const toast = useToast();
  const [edit, setEdit] = useState<any>(null);
  const decking = groupsOf(ref.catalog, 'decking');
  const fascia = groupsOf(ref.catalog, 'fascia');
  const systems = railingSystems(ref.catalog);
  const save = async () => { try { await api(`/api/packages/${edit.id}`, { method: 'PUT', body: edit }); setEdit(null); await ref.reload(); } catch (e) { toast((e as Error).message); } };
  return (
    <div className="col">
      <div className="sub">Define Good / Better / Best (or any) packages as explicit product mappings. A brand is never treated as a tier by default; each package states exactly what differs.</div>
      {me.role === 'admin' && <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => setEdit({ id: `pkg-${Date.now().toString(36)}`, name: '', tier: 'Good', kind: 'composite', includes: '' })}>＋ Package</button>}
      <div className="grid two">
        {ref.packages.map((p: any) => (
          <div key={p.id} className="card col">
            <div className="row"><span className="pill blue">{p.tier}</span><h3 style={{ flex: 1, margin: 0 }}>{p.name}</h3>{me.role === 'admin' && <button className="btn small" onClick={() => setEdit(p)}>Edit</button>}</div>
            <div className="small">Decking: {groupLabel(p.deckingGroup)} · Fascia: {groupLabel(p.fasciaGroup)} · Railing: {p.railingSystem ?? '—'} {p.railingColor ?? ''}</div>
            {p.includes && <div className="small">Includes: {p.includes}</div>}
          </div>
        ))}
      </div>
      <Sheet open={!!edit} onClose={() => setEdit(null)} title="Package" footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn primary" disabled={!edit?.name || !edit?.deckingGroup} onClick={save}>Save</button></>}>
        {edit && <div className="grid two">
          <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Tier label"><input className="input" value={edit.tier} onChange={(e) => setEdit({ ...edit, tier: e.target.value })} /></Field>
          <Field label="Material"><Segmented value={edit.kind} options={[{ value: 'wood', label: 'Wood' }, { value: 'composite', label: 'Composite' }]} onChange={(v) => setEdit({ ...edit, kind: v })} /></Field>
          <Field label="Decking"><select className="input" value={edit.deckingGroup ?? ''} onChange={(e) => setEdit({ ...edit, deckingGroup: e.target.value, brand: decking.find((g) => g.group === e.target.value)?.brand })}><option value="">Choose…</option>{decking.map((g) => <option key={g.group} value={g.group}>{groupLabel(g.group)}</option>)}</select></Field>
          <Field label="Fascia"><select className="input" value={edit.fasciaGroup ?? ''} onChange={(e) => setEdit({ ...edit, fasciaGroup: e.target.value || undefined })}><option value="">None</option>{fascia.map((g) => <option key={g.group} value={g.group}>{groupLabel(g.group)}</option>)}</select></Field>
          <Field label="Railing system"><select className="input" value={edit.railingSystem ?? ''} onChange={(e) => setEdit({ ...edit, railingSystem: e.target.value || undefined })}><option value="">None</option>{systems.map((s) => <option key={s.name}>{s.name}</option>)}</select></Field>
          <Field label="Railing color"><select className="input" value={edit.railingColor ?? ''} onChange={(e) => setEdit({ ...edit, railingColor: e.target.value || undefined })}><option value="">—</option>{systems.find((s) => s.name === edit.railingSystem)?.colors.map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Included upgrades / differences"><input className="input" value={edit.includes ?? ''} onChange={(e) => setEdit({ ...edit, includes: e.target.value })} /></Field>
        </div>}
      </Sheet>
    </div>
  );
}

function Settings() {
  const ref = useRefData();
  const me = useMe();
  const toast = useToast();
  const [s, setS] = useState<any>(null);
  useEffect(() => { api('/api/settings').then(setS); }, []);
  if (!s) return <div className="card">Loading…</div>;
  const save = async (key: string) => { try { await api(`/api/settings/${key}`, { method: 'PUT', body: s[key] }); toast('Saved'); await ref.reload(); } catch (e) { toast((e as Error).message); } };
  const set = (key: string, patch: any) => setS({ ...s, [key]: { ...s[key], ...patch } });
  const ro = me.role !== 'admin';
  return (
    <div className="col">
      <div className="card col">
        <h3>Company</h3>
        <div className="grid">{['name', 'phone', 'email', 'website', 'license'].map((k) => <Field key={k} label={k}><input className="input" readOnly={ro} value={s.company[k] ?? ''} onChange={(e) => set('company', { [k]: e.target.value })} /></Field>)}</div>
        {!ro && <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => save('company')}>Save</button>}
      </div>
      <div className="card col">
        <h3>Sales tax</h3>
        <div className="small">Tax treatment for deck construction in Kentucky depends on how contracts are structured. Enter only a treatment your accountant has verified. Until configured, estimates cannot be finalized.</div>
        <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)' }}><Toggle label="Tax treatment verified & configured" checked={!!s.tax.configured} onChange={(v) => set('tax', { configured: v })} /></div>
        <div className="grid">
          <Field label="Rate %"><NumberInput value={s.tax.ratePct} onChange={(v) => set('tax', { ratePct: v })} /></Field>
          <Field label="Taxable base"><Segmented value={s.tax.base} options={[{ value: 'materials', label: 'Materials' }, { value: 'all', label: 'Whole contract' }, { value: 'none', label: 'None' }]} onChange={(v) => set('tax', { base: v })} /></Field>
          <Field label="Verified by / note"><input className="input" value={s.tax.note ?? ''} onChange={(e) => set('tax', { note: e.target.value })} /></Field>
        </div>
        {!ro && <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => save('tax')}>Save</button>}
      </div>
      <div className="card col">
        <h3>Discount limits</h3>
        <div className="grid"><Field label="Salesman max %"><NumberInput value={s.discounts.salesmanMaxPct} onChange={(v) => set('discounts', { salesmanMaxPct: v ?? 0 })} /></Field><Field label="Manager max %"><NumberInput value={s.discounts.managerMaxPct} onChange={(v) => set('discounts', { managerMaxPct: v ?? 0 })} /></Field></div>
        {!ro && <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => save('discounts')}>Save</button>}
      </div>
      <div className="card col">
        <h3>Proposal terms & standard exclusions</h3>
        <Field label="Terms shown on proposals"><textarea className="input" value={s.proposal.terms} onChange={(e) => set('proposal', { terms: e.target.value })} /></Field>
        <Field label="Standard exclusions (one per line)"><textarea className="input" value={s.proposal.exclusions.join('\n')} onChange={(e) => set('proposal', { exclusions: e.target.value.split('\n').filter(Boolean) })} /></Field>
        {!ro && <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => save('proposal')}>Save</button>}
      </div>
      <div className="card col">
        <h3>Contract payment & warranty text</h3>
        <Field label="Payment terms"><textarea className="input" value={s.contractTerms.payment} onChange={(e) => set('contractTerms', { payment: e.target.value })} /></Field>
        <Field label="Warranty"><textarea className="input" value={s.contractTerms.warranty} onChange={(e) => set('contractTerms', { warranty: e.target.value })} /></Field>
        {!ro && <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => save('contractTerms')}>Save</button>}
      </div>
      <div className="card col">
        <h3>Pricing policy</h3>
        <div className="small">{s.pricingPolicy.note}</div>
        <div className="grid">
          <Field label="Project markup % (on material + labor selling prices)"><NumberInput value={s.pricingPolicy.projectMarkupPct} onChange={(v) => set('pricingPolicy', { projectMarkupPct: v ?? 0 })} /></Field>
          <Field label="Commission % (internal, of net price)"><NumberInput value={s.pricingPolicy.commissionPct} onChange={(v) => set('pricingPolicy', { commissionPct: v ?? 0 })} /></Field>
        </div>
        <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)' }}><Toggle label="Confirmed by owner" checked={!!s.pricingPolicy.confirmed} onChange={(v) => set('pricingPolicy', { confirmed: v })} /></div>
        {!ro && <button className="btn small primary" style={{ alignSelf: 'flex-start' }} onClick={() => save('pricingPolicy')}>Save</button>}
      </div>
      <JsonSetting title="Labor selection (labor price-book item names)" k="laborMap" s={s} setS={setS} save={save} ro={ro} note="The calculator picks labor items by these exact names. {tier} = deck height tier, {size}/{spacing} = joists, {width} = stair width band, {n} = pad size. railingBySystem maps each railing system to its install labor item; unmapped systems block pricing until added." />
      <JsonSetting title="Composite brands offered" k="brands" s={s} setS={setS} save={save} ro={ro} note="Brands appear in the consultation even before their products are imported." />
      <JsonSetting title="Zoho pipeline stage mapping" k="zohoStages" s={s} setS={setS} save={save} ro={ro} note="Pre-filled from your Zoho Deals stage list. Set confirmed=true only after checking these against the Yellowstone Renovation Sales pipeline. Stage pushes stay held until confirmed." />
      <JsonSetting title="Follow-up automation (not active)" k="followups" s={s} setS={setS} save={save} ro={ro} note="Defines day zero, timezone, cadence, resend behavior and stop conditions. No SMS provider is connected, so nothing is sent." />
    </div>
  );
}

function JsonSetting({ title, k, s, setS, save, ro, note }: any) {
  const [text, setText] = useState(JSON.stringify(s[k], null, 2));
  const [bad, setBad] = useState(false);
  return (
    <div className="card col">
      <h3>{title}</h3>
      <div className="small">{note}</div>
      <textarea className={`input mono${bad ? ' bad' : ''}`} style={{ minHeight: 180 }} readOnly={ro} value={text} onChange={(e) => { setText(e.target.value); try { setS({ ...s, [k]: JSON.parse(e.target.value) }); setBad(false); } catch { setBad(true); } }} />
      {!ro && <button className="btn small primary" disabled={bad} style={{ alignSelf: 'flex-start' }} onClick={() => save(k)}>Save</button>}
    </div>
  );
}

function Template() {
  const me = useMe();
  const toast = useToast();
  const [t, setT] = useState<any>(null);
  useEffect(() => { api('/api/contract-templates').then((l) => setT(l.find((x: any) => x.id === 'default') ?? { id: 'default', name: 'Contract', body: '' })); }, []);
  const placeholders = useMemo(() => [...new Set([...(t?.body ?? '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m: any) => m[1]))], [t?.body]);
  if (!t) return null;
  return (
    <div className="col">
      <div className="sub">The template is filled from the approved proposal snapshot. Unknown values appear as [[MISSING: …]] and must be filled before signature. This app does not supply legal terms.</div>
      <Field label="Name"><input className="input" value={t.name} readOnly={me.role !== 'admin'} onChange={(e) => setT({ ...t, name: e.target.value })} /></Field>
      <textarea className="input mono" style={{ minHeight: 520 }} readOnly={me.role !== 'admin'} value={t.body} onChange={(e) => setT({ ...t, body: e.target.value })} />
      <div className="small">Placeholders used: {placeholders.join(', ')}</div>
      {me.role === 'admin' && <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => api(`/api/contract-templates/${t.id}`, { method: 'PUT', body: t }).then((r) => toast(`Saved v${r.version}`))}>Save new version</button>}
    </div>
  );
}

function Users() {
  const me = useMe();
  const toast = useToast();
  const [list, setList] = useState<any[]>([]);
  const [f, setF] = useState<any>({ role: 'salesman' });
  const load = () => api('/api/users').then(setList);
  useEffect(() => { void load(); }, []);
  return (
    <div className="col">
      <div className="group">{list.map((u) => <div key={u.id} className="item"><b style={{ flex: 1 }}>{u.name}</b><span className="small">{u.email}</span><span className="pill">{u.role}</span></div>)}</div>
      {me.role === 'admin' && <div className="card col">
        <h3>Add user</h3>
        <div className="grid">
          <Field label="Name"><input className="input" value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email"><input className="input" value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Temporary password"><input className="input" value={f.password ?? ''} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label="Role"><Segmented value={f.role} options={[{ value: 'salesman', label: 'Salesman' }, { value: 'manager', label: 'Manager' }, { value: 'admin', label: 'Admin' }]} onChange={(v) => setF({ ...f, role: v })} /></Field>
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => api('/api/users', { body: f }).then(() => { setF({ role: 'salesman' }); return load(); }).catch((e) => toast(e.message))}>Create</button>
      </div>}
    </div>
  );
}
