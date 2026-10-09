import { useState } from 'react';
import type { BeamInput, EstimateDoc, LedgerSubstrate, Override, StairInput } from '../../../shared/types';
import type { StepDef, StepProps } from '../Estimate';
import { Field, IssueList, LengthInput, NumberInput, Segmented, Sheet, Toggle } from '../../components/ui';
import { SketchEditor } from '../../components/SketchEditor';
import { formatFtIn } from '../../../engine/units';
import { lumberDepth } from '../../../engine/estimate';
import { uid } from '../../lib/api';
import { ElevationArt } from '../../components/Art';
import { Review } from './Review';
import { useMe } from '../../components/Shell';

const SIZES = ['2x6', '2x8', '2x10', '2x12'];
const issuesFor = (p: StepProps, areas: string[]) => [...p.result.issues, ...p.result.alternatives.flatMap((a) => a.issues)].filter((i, k, arr) => areas.includes(i.area) && arr.findIndex((x) => x.id === i.id) === k);

export function OverrideSheet({ open, title, current, computed, unit, onClose, onSave }: { open: boolean; title: string; current?: Override; computed?: number; unit: string; onClose: () => void; onSave: (o: Override | undefined) => void }) {
  const me = useMe();
  const [v, setV] = useState<number | undefined>(current?.value);
  const [reason, setReason] = useState(current?.reason ?? '');
  return (
    <Sheet open={open} title={title} onClose={onClose} footer={<>
      {current && <button className="btn danger" onClick={() => onSave(undefined)}>Remove override</button>}
      <div className="spacer" />
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={v === undefined || !reason.trim()} onClick={() => onSave({ value: v!, reason: reason.trim(), by: me.name, at: new Date().toISOString(), role: me.role })}>Save override</button>
    </>}>
      {computed !== undefined && <p>Calculated value: <b>{Math.round(computed * 100) / 100} {unit}</b>. Both values are kept; the override is audited and visible to managers.</p>}
      <div className="grid two">
        <Field label={`Override value (${unit})`}><NumberInput value={v} onChange={setV} min={0} /></Field>
        <Field label="Reason (required)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is the calculated value not right?" /></Field>
      </div>
    </Sheet>
  );
}

function GeometryStep(p: StepProps) {
  const { doc, update, result } = p;
  const [ovr, setOvr] = useState(false);
  return (
    <div className="col" style={{ gap: 14 }}>
      <p className="sub" style={{ marginTop: -8 }}>Measure, then type or draw. Lengths accept 16', 16' 3 1/2", 16-3 or inches. Everything is stored in exact inches.</p>
      <SketchEditor geometry={doc.geometry} onChange={(g) => update((d) => { d.geometry = g; })} onOverride={() => setOvr(true)} />
      <div className="grid two">
        <div className="card">
          <h3>Edges summary</h3>
          <div className="small">House edges: {Object.values(doc.geometry.edgeTags).filter((t) => t.side === 'house').length} · Railed edges: {Object.values(doc.geometry.edgeTags).filter((t) => t.rail).length} · Fascia edges: {Object.values(doc.geometry.edgeTags).filter((t) => t.fascia).length}</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => update((d) => { for (const s of d.geometry.shapes) { const n = s.kind === 'rect' ? 4 : s.kind === 'triangle' ? 3 : 0; for (let i = 0; i < n; i++) { const k = `${s.id}:${i}`; const t = d.geometry.edgeTags[k] ?? { side: 'open' }; if (t.side === 'open') d.geometry.edgeTags[k] = { ...t, rail: !!d.consult.railing.wanted, fascia: !!d.consult.fascia }; } } })}>Apply rail/fascia to all exposed edges</button>
          </div>
          <div className="small" style={{ marginTop: 8 }}>Shared edges between areas are internal — they never receive rail or fascia.</div>
        </div>
        <div className="card">
          <h3>Heights</h3>
          {doc.geometry.shapes.map((s) => (
            <div key={s.id} className="row" style={{ marginBottom: 6 }}>
              <span style={{ flex: 1 }}>{s.label}</span>
              <div style={{ width: 180 }}><LengthInput value={s.heightIn} onChange={(v) => update((d) => { d.geometry.shapes.find((x) => x.id === s.id)!.heightIn = v; })} placeholder="height above grade" /></div>
            </div>
          ))}
          {doc.geometry.shapes.length > 1 && new Set(doc.geometry.shapes.map((s) => s.heightIn)).size > 1 && <div className="issue review" style={{ marginTop: 8 }}><span className="ico">?</span>Areas have different heights — add steps between levels in Stairs.</div>}
        </div>
      </div>
      <IssueList issues={issuesFor(p, ['geometry'])} />
      <OverrideSheet open={ovr} title="Override deck area" unit="sq ft" computed={result.area.computedSqFt} current={doc.geometry.areaOverride} onClose={() => setOvr(false)} onSave={(o) => { update((d) => { d.geometry.areaOverride = o; }); setOvr(false); }} />
    </div>
  );
}

function StructureStep(p: StepProps) {
  const { doc, update, result } = p;
  const st = doc.structure;
  const f = result.framing;
  const setSt = (m: (s: EstimateDoc['structure']) => void) => update((d) => m(d.structure));
  const subs: [LedgerSubstrate, string][] = [['wood-rim-joist', 'Wood rim/band joist (verified)'], ['brick-veneer', 'Brick veneer'], ['solid-masonry', 'Solid masonry'], ['concrete-foundation', 'Concrete foundation'], ['siding-unknown-backing', 'Siding — backing not verified'], ['unknown', 'Unknown'], ['other', 'Other']];
  const addBeam = () => setSt((s) => { s.beams.push({ id: `B${s.beams.length + 1}`, offsetIn: Math.max(0, (f?.lengthAlongIn ?? 144) - 24), size: s.joist.size ?? '2x10', plies: 2, postSpacingIn: 96 }); });
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="grid two">
        <div className="card col">
          <h3>Attachment</h3>
          <Segmented value={st.attachment} options={[{ value: 'attached', label: 'Attached to house (ledger)' }, { value: 'freestanding', label: 'Freestanding' }]} onChange={(v) => setSt((s) => { s.attachment = v; })} />
          {st.attachment === 'attached' && <>
            <Field label="What the ledger attaches to"><select className="input" value={st.ledger.substrate} onChange={(e) => setSt((s) => { s.ledger.substrate = e.target.value as LedgerSubstrate; })}>{subs.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Wall construction"><input className="input" value={st.ledger.wallConstruction ?? ''} onChange={(e) => setSt((s) => { s.ledger.wallConstruction = e.target.value; })} placeholder="e.g. vinyl siding over OSB, 2x10 band verified from basement" /></Field>
            <Field label="Flashing"><Segmented value={st.ledger.flashing} options={[{ value: 'needed', label: 'New flashing' }, { value: 'existing-ok', label: 'Existing OK' }, { value: 'unknown', label: 'Unknown' }]} onChange={(v) => setSt((s) => { s.ledger.flashing = v; })} /></Field>
            {['brick-veneer', 'solid-masonry', 'concrete-foundation', 'other'].includes(st.ledger.substrate) && <Field label="Verified attachment detail reference" hint="Engineer letter or approved detail number. Without it the deck must be freestanding at the house."><input className="input" value={st.ledger.verifiedDetailRef ?? ''} onChange={(e) => setSt((s) => { s.ledger.verifiedDetailRef = e.target.value || undefined; })} /></Field>}
            <Field label="Access / notes"><input className="input" value={st.ledger.access ?? ''} onChange={(e) => setSt((s) => { s.ledger.access = e.target.value; })} /></Field>
          </>}
        </div>
        <div className="card col">
          <h3>Joists</h3>
          <div className="grid">
            <Field label="Spacing (on-center)"><Segmented value={st.joist.spacingIn} options={[12, 16, 24].map((v) => ({ value: v, label: `${v}"` }))} onChange={(v) => setSt((s) => { s.joist.spacingIn = v; })} /></Field>
            <Field label="Size"><Segmented value={st.joist.size} options={SIZES.map((v) => ({ value: v, label: v }))} onChange={(v) => setSt((s) => { s.joist.size = v; })} /></Field>
            <Field label="Species / grade" hint={p.refData.rules ? `Must match the active rule set (${p.refData.rules.joistSpans.map((r) => r.speciesGrade).filter((x, i, a) => a.indexOf(x) === i).join(', ') || 'no rows'})` : 'No verified rule set is active'}>
              <input className="input" list="species" value={st.joist.speciesGrade ?? ''} onChange={(e) => setSt((s) => { s.joist.speciesGrade = e.target.value; })} />
              <datalist id="species">{[...new Set(p.refData.rules?.joistSpans.map((r) => r.speciesGrade) ?? [])].map((x) => <option key={x} value={x} />)}</datalist>
            </Field>
            <Field label="Rim plies"><Segmented value={st.joist.rimPlies} options={[{ value: 1, label: 'Single' }, { value: 2, label: 'Double' }]} onChange={(v) => setSt((s) => { s.joist.rimPlies = v; })} /></Field>
          </div>
          {f && f.baseLineCount > 0 && (
            <div className="trace">
              <div><b>{f.baseLineCount} base joist lines</b> — {f.formula}</div>
              <div>Joist pieces: {f.joistCuts.length} ({[...new Set(f.joistCuts.map((c) => formatFtIn(c.lengthIn)))].join(', ')})</div>
              <div>Additional framing (separate): {f.extraJoistCuts.length} boundary/doubled · {f.rimCuts.length} rim · {f.ledgerCuts.length} ledger ({formatFtIn(f.ledgerLengthIn)})</div>
              <div className="small">Convention: joists run at {doc.geometry.joistAngleDeg}°; width is measured perpendicular to the joists, with a boundary joist at each end. Counting only — spans are checked below.</div>
            </div>
          )}
        </div>
      </div>
      <div className="card col">
        <div className="row"><h3 style={{ flex: 1, margin: 0 }}>Beams & posts</h3><button className="btn small primary" onClick={addBeam}>＋ Beam line</button></div>
        <div className="small">Position beams where they will actually go. Post counts come from beam length ÷ your post spacing (+1 per beam piece) and are checked against the verified beam table — never from deck size alone.</div>
        {st.beams.map((b, i) => {
          const fb = f?.beams.find((x) => x.id === b.id);
          const set = (m: (x: BeamInput) => void) => setSt((s) => m(s.beams[i]));
          return (
            <div key={b.id} className="card flat">
              <div className="row"><b>{b.id}</b><span className="small">{fb ? `${formatFtIn(fb.lengthIn)} long · ${fb.posts} posts${fb.overridden ? ' (override)' : ''}` : ''}</span><div className="spacer" /><button className="btn small danger" onClick={() => setSt((s) => { s.beams.splice(i, 1); })}>Remove</button></div>
              <div className="grid">
                <Field label="Distance from house/inner edge"><LengthInput value={b.offsetIn} onChange={(v) => v !== undefined && set((x) => { x.offsetIn = v; })} /></Field>
                <Field label="Size"><Segmented value={b.size} options={SIZES.map((v) => ({ value: v, label: v }))} onChange={(v) => set((x) => { x.size = v; })} /></Field>
                <Field label="Plies"><Segmented value={b.plies} options={[1, 2, 3].map((v) => ({ value: v, label: `${v}` }))} onChange={(v) => set((x) => { x.plies = v; })} /></Field>
                <Field label="Post spacing"><LengthInput value={b.postSpacingIn} onChange={(v) => set((x) => { x.postSpacingIn = v; })} /></Field>
                <Field label="Overhang each end"><LengthInput value={b.overhangIn} onChange={(v) => set((x) => { x.overhangIn = v; })} /></Field>
              </div>
            </div>
          );
        })}
        <div className="grid">
          <Field label="Post size"><Segmented value={st.postSize} options={['4x4', '6x6'].map((v) => ({ value: v, label: v }))} onChange={(v) => setSt((s) => { s.postSize = v; })} /></Field>
          <Field label="Design live load (psf)"><NumberInput value={st.designLoadPsf?.live} onChange={(v) => setSt((s) => { s.designLoadPsf = { ...s.designLoadPsf, live: v }; })} /></Field>
        </div>
        {f && f.spans.length > 0 && <div className="trace">{f.spans.map((s, i) => <div key={i}>Joist span {formatFtIn(s.fromIn)} → {formatFtIn(s.toIn)}: <b>{formatFtIn(s.spanIn)}</b></div>)}<div>Cantilever beyond last beam: <b>{formatFtIn(f.cantileverIn)}</b></div><div>{f.structuralVerified ? '✓ Within the verified rule set' : 'Not structurally verified — see items below'}</div></div>}
      </div>
      <IssueList issues={issuesFor(p, ['structure'])} />
    </div>
  );
}

function FootingsStep(p: StepProps) {
  const { doc, update, result } = p;
  const ft = doc.footings;
  const set = (m: (f: EstimateDoc['footings']) => void) => update((d) => m(d.footings));
  const concretes = p.refData.catalog.filter((c) => c.active && c.category === 'concrete');
  const [ovr, setOvr] = useState(false);
  return (
    <div className="col" style={{ gap: 14 }}>
      <Segmented value={ft.support} options={[{ value: 'new-footings', label: 'New footings' }, { value: 'existing-footings', label: 'Reuse existing footings' }, { value: 'existing-concrete', label: 'On existing concrete' }, { value: 'on-grade-pad', label: 'On-grade pad' }, { value: 'unknown', label: 'Not decided' }]} onChange={(v) => set((f) => { f.support = v; })} />
      {(ft.support === 'existing-footings' || ft.support === 'existing-concrete') && (
        <div className="card col">
          <h3>Reuse inspection (required)</h3>
          <div className="small">Existing concrete is not assumed adequate. Record who inspected it, its known dimensions and approval.</div>
          <div className="grid">
            <Field label="Inspected by"><input className="input" value={ft.reuseInspection?.inspectedBy ?? ''} onChange={(e) => set((f) => { f.reuseInspection = { inspectedBy: e.target.value, date: f.reuseInspection?.date ?? new Date().toISOString().slice(0, 10), dimensionsKnown: !!f.reuseInspection?.dimensionsKnown, approved: !!f.reuseInspection?.approved, notes: f.reuseInspection?.notes }; })} /></Field>
            <Field label="Date"><input className="input" type="date" value={ft.reuseInspection?.date ?? ''} onChange={(e) => set((f) => { if (f.reuseInspection) f.reuseInspection.date = e.target.value; })} /></Field>
          </div>
          <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)' }}>
            <Toggle label="Dimensions known and recorded" checked={!!ft.reuseInspection?.dimensionsKnown} onChange={(v) => set((f) => { f.reuseInspection = { ...(f.reuseInspection ?? { inspectedBy: '', date: '' }), dimensionsKnown: v, approved: !!f.reuseInspection?.approved }; })} />
            <Toggle label="Approved for reuse" checked={!!ft.reuseInspection?.approved} onChange={(v) => set((f) => { f.reuseInspection = { ...(f.reuseInspection ?? { inspectedBy: '', date: '' }), approved: v, dimensionsKnown: !!f.reuseInspection?.dimensionsKnown }; })} />
          </div>
        </div>
      )}
      {ft.support === 'new-footings' && (
        <div className="grid two">
          <div className="card col">
            <h3>Footing size</h3>
            <Segmented value={ft.spec.shape} options={[{ value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }]} onChange={(v) => set((f) => { f.spec.shape = v; })} />
            <div className="grid">
              {ft.spec.shape === 'round' ? <Field label="Diameter"><LengthInput defaultUnit="in" value={ft.spec.diameterIn} onChange={(v) => set((f) => { f.spec.diameterIn = v; })} /></Field> : <Field label="Width"><LengthInput defaultUnit="in" value={ft.spec.widthIn} onChange={(v) => set((f) => { f.spec.widthIn = v; })} /></Field>}
              <Field label="Depth below grade"><LengthInput defaultUnit="in" value={ft.spec.depthIn} onChange={(v) => set((f) => { f.spec.depthIn = v; })} /></Field>
              <Field label="Pier above grade"><LengthInput defaultUnit="in" value={ft.spec.pierAboveGradeIn} onChange={(v) => set((f) => { f.spec.pierAboveGradeIn = v; })} /></Field>
              <Field label="Reinforcement"><input className="input" value={ft.spec.reinforcement ?? ''} onChange={(e) => set((f) => { f.spec.reinforcement = e.target.value; })} /></Field>
            </div>
            <div className="grid">
              <Field label="Soil assumption"><input className="input" value={ft.soilAssumption ?? ''} onChange={(e) => set((f) => { f.soilAssumption = e.target.value; })} /></Field>
              <Field label="Approved bearing (psf)"><NumberInput value={ft.bearingAssumptionPsf} onChange={(v) => set((f) => { f.bearingAssumptionPsf = v; })} /></Field>
            </div>
          </div>
          <div className="card col">
            <h3>Concrete</h3>
            <Field label="Product (yield from catalog)"><select className="input" value={ft.concreteSku ?? ''} onChange={(e) => set((f) => { f.concreteSku = e.target.value || undefined; })}><option value="">Choose…</option>{concretes.map((c) => <option key={c.sku} value={c.sku}>{c.description}{c.yieldCuFt ? ` — ${c.yieldCuFt} cu ft/bag` : ' — yield missing'}</option>)}</select></Field>
            <Field label="Concrete waste %"><NumberInput value={ft.wastePct} unit="%" onChange={(v) => set((f) => { f.wastePct = v ?? 0; })} /></Field>
            <div className="row"><span>Footings: <b>{ft.countOverride ? ft.countOverride.value : result.framing?.postCount ?? 0}</b> {ft.countOverride ? '(override)' : '(one per structural post)'}</span><button className="btn small" onClick={() => setOvr(true)}>Override</button></div>
            <Toggle label="Excavation & spoil disposal" checked={!!ft.excavationDisposal} onChange={(v) => set((f) => { f.excavationDisposal = v; })} />
            {result.alternatives[0]?.lines.filter((l) => l.group === 'Footings').map((l) => <div key={l.key} className="trace"><b>{l.purchaseQty} {l.unit}</b> {l.description}<div>{l.formula}</div></div>)}
          </div>
        </div>
      )}
      <Field label="Access for digging / equipment"><input className="input" value={ft.accessNotes ?? ''} onChange={(e) => set((f) => { f.accessNotes = e.target.value; })} /></Field>
      <IssueList issues={issuesFor(p, ['footings'])} />
      <OverrideSheet open={ovr} title="Override footing count" unit="footings" computed={result.framing?.postCount} current={ft.countOverride} onClose={() => setOvr(false)} onSave={(o) => { set((f) => { f.countOverride = o; }); setOvr(false); }} />
    </div>
  );
}

function DeckingStep(p: StepProps) {
  const { doc, update, result } = p;
  const dk = doc.decking;
  const set = (m: (x: EstimateDoc['decking']) => void) => update((d) => m(d.decking));
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="grid two">
        <div className="card col">
          <h3>Layout</h3>
          <Field label="Board direction (degrees from house line)"><Segmented value={doc.geometry.deckingAngleDeg} options={[{ value: 0, label: 'Parallel 0°' }, { value: 45, label: 'Diagonal 45°' }, { value: 90, label: 'Perpendicular 90°' }]} onChange={(v) => update((d) => { d.geometry.deckingAngleDeg = v; d.decking.pattern = v % 90 ? 'diagonal' : 'straight'; d.geometry.joistAngleDeg = v === 90 ? 0 : 90; })} /></Field>
          <Field label="Picture-frame courses"><Segmented value={dk.pictureFrameCourses} options={[0, 1, 2, 3].map((v) => ({ value: v, label: v ? `${v}` : 'None' }))} onChange={(v) => set((x) => { x.pictureFrameCourses = v as 0 | 1 | 2 | 3; })} /></Field>
          <Field label="Gap override (blank = product spec)"><LengthInput defaultUnit="in" value={dk.gapOverrideIn} onChange={(v) => set((x) => { x.gapOverrideIn = v; })} /></Field>
        </div>
        <div className="card col">
          <h3>Cutting & waste</h3>
          <div className="grid">
            <Field label="Saw kerf"><LengthInput defaultUnit="in" value={dk.kerfIn} onChange={(v) => set((x) => { x.kerfIn = v ?? 0; })} /></Field>
            <Field label="Shortest reusable offcut"><LengthInput value={dk.minReusableIn} onChange={(v) => set((x) => { x.minReusableIn = v ?? 0; })} /></Field>
            <Field label="Extra waste (company policy)" hint={(() => { const w = p.refData.catalog.find((c) => c.active && c.allowance && c.purchaseUnit === 'pct' && /deck/i.test(c.description)); return w ? <>Price book: {w.description} = {w.cost}% <button type="button" className="btn small" onClick={() => set((x) => { x.extraWastePct = w.cost ?? 0; })}>Apply</button> — added on top of the board-by-board cut waste.</> : undefined; })()}><NumberInput value={dk.extraWastePct} unit="%" onChange={(v) => set((x) => { x.extraWastePct = v ?? 0; })} /></Field>
            {doc.consult.fascia && <Field label="Fascia rows (blank = rim depth ÷ fascia height)"><NumberInput value={dk.fasciaRows} onChange={(v) => set((x) => { x.fasciaRows = v; })} /></Field>}
          </div>
          <div className="small">Area ({result.area.effectiveSqFt.toFixed(1)} sq ft) and waste are separate: waste comes from the board-by-board cut allocation plus the policy % above.</div>
        </div>
      </div>
      {result.alternatives.map((a) => a.decking && (
        <div key={a.alternative.id} className="card">
          <div className="row"><h3 style={{ flex: 1, margin: 0 }}>{a.alternative.name}</h3><span className="pill">{a.decking.rows} rows</span><span className="pill">{a.decking.crossings} joist crossings</span>{a.decking.fieldAllocation && <span className="pill">{a.decking.fieldAllocation.wastePct.toFixed(1)}% cut waste</span>}</div>
          <div className="trace"><div>{a.decking.rowFormula}</div>{a.decking.fieldAllocation && <div>{a.decking.fieldAllocation.method}</div>}</div>
          <div className="scroll-x" style={{ marginTop: 10 }}>
            <table className="t">
              <thead><tr><th>Board</th><th>Stock</th><th>Cuts</th><th className="num">Offcut</th></tr></thead>
              <tbody>
                {a.decking.fieldAllocation?.boards.slice(0, 60).map((b) => <tr key={b.n}><td>#{b.n}</td><td>{formatFtIn(b.stock.lengthIn)} {b.stock.sku}</td><td>{b.cuts.map((c) => `${c.id} ${formatFtIn(c.lengthIn)}`).join(' · ')}</td><td className="num">{formatFtIn(b.remainderIn)}</td></tr>)}
              </tbody>
            </table>
            {(a.decking.fieldAllocation?.boards.length ?? 0) > 60 && <div className="small">…and {a.decking.fieldAllocation!.boards.length - 60} more boards (full list in Review).</div>}
          </div>
        </div>
      ))}
      <IssueList issues={issuesFor(p, ['decking'])} />
    </div>
  );
}

function RailingTechStep(p: StepProps) {
  const { doc, update, result } = p;
  const [ovr, setOvr] = useState(false);
  if (!doc.consult.railing.wanted) return <div className="card">No railing selected in the consultation. <button className="btn small" onClick={() => update((d) => { d.consult.railing.wanted = true; })}>Add railing</button><div className="small" style={{ marginTop: 8 }}>Guard requirements are still checked against the verified rules for the deck height.</div></div>;
  const r = result.alternatives[0]?.railing;
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="small">Railing runs follow the edges marked "Railing required" in Geometry. House edges and gate/stair openings are excluded. Edit edges and openings on the sketch.</div>
      {r && (
        <div className="card">
          <div className="row"><h3 style={{ flex: 1, margin: 0 }}>Suggested railing</h3><span className="pill">{formatFtIn(r.totalLengthIn)} total</span><span className="pill">{r.sections} sections</span><span className="pill">{r.posts} posts ({r.sharedCornerPosts} shared corners)</span></div>
          <table className="t" style={{ marginTop: 10 }}>
            <thead><tr><th>Run</th><th>Legs</th><th className="num">Length</th><th className="num">Posts</th></tr></thead>
            <tbody>{r.runs.map((run) => <tr key={run.id}><td>{run.id}{run.closed ? ' (loop)' : ''}</td><td>{run.legs.map((l) => `${formatFtIn(l.lengthIn)} → ${l.sections}× ${l.kitSku ?? '?'} @ ${formatFtIn(l.sectionLengthIn)}`).join(' | ')}</td><td className="num">{formatFtIn(run.lengthIn)}</td><td className="num">{run.posts}</td></tr>)}</tbody>
          </table>
          <div className="row" style={{ marginTop: 10 }}><button className="btn small" onClick={() => setOvr(true)}>Override rail length…</button>{doc.geometry.railLengthOverride && <span className="pill orange">Override {doc.geometry.railLengthOverride.value} ft — {doc.geometry.railLengthOverride.reason}</span>}</div>
        </div>
      )}
      <div className="card col">
        <h3>Gates</h3>
        <div className="small">Gate openings on the sketch: {doc.geometry.openings.filter((o) => o.kind === 'gate').length}{doc.consult.gates.wanted ? ` · customer asked for ${doc.consult.gates.count ?? 1}` : ''}</div>
        {doc.consult.gates.wanted && doc.geometry.openings.filter((o) => o.kind === 'gate').length < (doc.consult.gates.count ?? 1) && <div className="issue review"><span className="ico">?</span>Place the gate opening on an edge in Geometry so railing and gate kits are counted.</div>}
      </div>
      <IssueList issues={issuesFor(p, ['railing'])} />
      <OverrideSheet open={ovr} title="Override railing length" unit="ft" computed={r ? r.totalLengthIn / 12 : undefined} current={doc.geometry.railLengthOverride} onClose={() => setOvr(false)} onSave={(o) => { update((d) => { d.geometry.railLengthOverride = o; }); setOvr(false); }} />
    </div>
  );
}

function StairsTechStep(p: StepProps) {
  const { doc, update, result } = p;
  const add = () => update((d) => { d.stairs.push({ id: `st${uid().slice(0, 4)}`, label: `Stairs ${d.stairs.length + 1}`, topConvention: 'deck-top', railsLeft: true, railsRight: true, riserBoards: !!d.consult.fascia, widthIn: d.consult.stairs.approxWidthIn, treadDepthIn: 10.5, lightsPerRiser: d.consult.extras.lighting.stair ? 1 : 0, totalRiseIn: Math.max(0, ...d.geometry.shapes.map((s) => s.heightIn ?? 0)) || undefined }); });
  const r0 = (id: string) => result.alternatives[0]?.stairs.find((s) => s.id === id);
  const openings = doc.geometry.openings.filter((o) => o.kind === 'stair');
  return (
    <div className="col" style={{ gap: 14 }}>
      {doc.stairs.length === 0 && <div className="card">{doc.consult.stairs.wanted ? 'The customer wants stairs — add them here.' : 'No stairs planned.'} <button className="btn small primary" onClick={add}>＋ Add stairs</button></div>}
      {doc.stairs.map((s, i) => {
        const set = (m: (x: StairInput) => void) => update((d) => m(d.stairs[i]));
        const r = r0(s.id);
        return (
          <div key={s.id} className="card col">
            <div className="row"><input className="input" style={{ maxWidth: 240, fontWeight: 600 }} value={s.label} onChange={(e) => set((x) => { x.label = e.target.value; })} /><div className="spacer" /><button className="btn small danger" onClick={() => update((d) => { d.stairs.splice(i, 1); d.geometry.openings = d.geometry.openings.filter((o) => o.stairId !== s.id); })}>Remove</button></div>
            <div className="grid two">
              <div className="col">
                <div className="grid">
                  <Field label="Total rise (finished deck → landing)" hint="Required. Measure at the landing location."><LengthInput defaultUnit="in" value={s.totalRiseIn} onChange={(v) => set((x) => { x.totalRiseIn = v; })} /></Field>
                  <Field label="Width"><LengthInput value={s.widthIn} onChange={(v) => set((x) => { x.widthIn = v; })} /></Field>
                  <Field label="Tread depth (run)"><LengthInput defaultUnit="in" value={s.treadDepthIn} onChange={(v) => set((x) => { x.treadDepthIn = v; })} /></Field>
                  <Field label="Available run"><LengthInput value={s.availableRunIn} onChange={(v) => set((x) => { x.availableRunIn = v; })} /></Field>
                  <Field label="Stringer spacing (blank = rule max)"><LengthInput defaultUnit="in" value={s.stringerSpacingIn} onChange={(v) => set((x) => { x.stringerSpacingIn = v; })} /></Field>
                  <Field label="Lights per riser"><NumberInput value={s.lightsPerRiser} onChange={(v) => set((x) => { x.lightsPerRiser = v; })} /></Field>
                </div>
                <Field label="Top step convention"><Segmented value={s.topConvention} options={[{ value: 'deck-top', label: 'Deck is the top step' }, { value: 'flush', label: 'Flush top tread' }]} onChange={(v) => set((x) => { x.topConvention = v; })} /></Field>
                <Field label="Placed on deck edge">
                  <select className="input" value={openings.find((o) => o.stairId === s.id)?.id ?? ''} onChange={(e) => update((d) => { for (const o of d.geometry.openings) { if (o.stairId === s.id) o.stairId = undefined; if (o.id === e.target.value) o.stairId = s.id; } })}>
                    <option value="">Not placed — add a stair opening on the sketch</option>
                    {openings.map((o) => <option key={o.id} value={o.id}>Opening on edge {o.edgeKey} ({formatFtIn(o.widthIn)} wide)</option>)}
                  </select>
                </Field>
                <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)' }}>
                  <Toggle label="Rail left" checked={s.railsLeft} onChange={(v) => set((x) => { x.railsLeft = v; })} />
                  <Toggle label="Rail right" checked={s.railsRight} onChange={(v) => set((x) => { x.railsRight = v; })} />
                  <Toggle label="Riser boards" checked={s.riserBoards} onChange={(v) => set((x) => { x.riserBoards = v; })} />
                </div>
                <Field label="Landing / pad">
                  <Segmented value={s.landing?.type} options={[{ value: 'concrete-pad', label: 'Concrete pad' }, { value: 'pavers', label: 'Pavers' }, { value: 'gravel', label: 'Gravel' }, { value: 'existing', label: 'Existing' }]} onChange={(v) => set((x) => { x.landing = { widthIn: x.landing?.widthIn ?? (x.widthIn ?? 48) + 12, depthIn: x.landing?.depthIn ?? 36, type: v }; })} />
                </Field>
              </div>
              <div className="col">
                <StairPreview s={s} r={r} />
                {r && r.risers > 0 && <div className="trace">{r.formulas.map((f, k) => <div key={k}>{f}</div>)}<div>Stringers: <b>{r.stringers}</b> · tread boards: <b>{r.treadCuts.length}</b> · riser boards: <b>{r.riserCuts.length}</b> · lights: <b>{r.lights}</b></div></div>}
              </div>
            </div>
          </div>
        );
      })}
      {doc.stairs.length > 0 && <button className="btn" onClick={add}>＋ Add another stair</button>}
      <IssueList issues={issuesFor(p, ['stairs'])} />
    </div>
  );
}

function StairPreview({ s, r }: { s: StairInput; r?: { risers: number; treads: number; actualRiseIn: number; totalRunIn: number } }) {
  if (!r || !r.risers || !s.treadDepthIn) return <div className="card flat" style={{ padding: 0, overflow: 'hidden' }}><div style={{ aspectRatio: '16/10' }}><ElevationArt stairs rail /></div></div>;
  const W = 340, H = 220, pad = 28;
  const total = s.totalRiseIn!;
  const run = Math.max(r.totalRunIn, s.treadDepthIn);
  const k = Math.min((W - pad * 2 - 40) / run, (H - pad * 2) / total);
  const steps: JSX.Element[] = [];
  let x = pad + 40, y = pad;
  for (let i = 0; i < r.risers; i++) {
    const ny = y + r.actualRiseIn * k;
    steps.push(<line key={`r${i}`} x1={x} y1={y} x2={x} y2={ny} stroke="var(--text)" strokeWidth={2} />);
    y = ny;
    if (i < r.treads || s.topConvention === 'flush') { const nx = x + s.treadDepthIn * k; steps.push(<line key={`t${i}`} x1={x} y1={y} x2={nx} y2={y} stroke="var(--brand)" strokeWidth={3} />); x = nx; }
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', background: 'var(--bg-sunken)', borderRadius: 14 }}>
      <rect x={0} y={pad - 6} width={pad + 40} height={6} fill="var(--brand)" />
      <text x={6} y={pad - 10} fontSize={10} fill="var(--text-3)">deck</text>
      {steps}
      <line x1={0} y1={pad + total * k} x2={W} y2={pad + total * k} stroke="#7aa262" strokeWidth={3} />
      <text x={W - pad} y={pad + 10} fontSize={11} textAnchor="end" fill="var(--text-2)">{r.risers} risers × {formatFtIn(r.actualRiseIn)}</text>
      <text x={W - pad} y={pad + 26} fontSize={11} textAnchor="end" fill="var(--text-2)">{r.treads} treads × {formatFtIn(s.treadDepthIn)} = {formatFtIn(r.totalRunIn)} run</text>
      <text x={12} y={pad + (total * k) / 2} fontSize={11} fill="var(--text-2)">{formatFtIn(total)}</text>
    </svg>
  );
}

function DemolitionStep(p: StepProps) {
  const { doc, update } = p;
  const dm = doc.demolition;
  const set = (m: (x: EstimateDoc['demolition']) => void) => update((d) => m(d.demolition));
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="grid two">
        <div className="card">
          <h3>Removal (measured)</h3>
          <div className="group" style={{ boxShadow: 'none', border: '0.5px solid var(--sep)' }}>
            <Toggle label="Remove decking" checked={dm.removeDecking} onChange={(v) => set((x) => { x.removeDecking = v; })} />
            <Toggle label="Remove railings" checked={dm.removeRails} onChange={(v) => set((x) => { x.removeRails = v; })} />
            <Toggle label="Remove framing" checked={dm.removeFraming} onChange={(v) => set((x) => { x.removeFraming = v; })} />
            <Toggle label="Remove footings" checked={dm.removeFootings} onChange={(v) => set((x) => { x.removeFootings = v; })} />
          </div>
          <Field label="Condition & scope of retained structure"><textarea className="input" value={dm.retainedStructureCondition ?? ''} onChange={(e) => set((x) => { x.retainedStructureCondition = e.target.value; })} /></Field>
          <Field label="Disposal"><Segmented value={dm.disposal} options={[{ value: 'dumpster', label: 'Dumpster' }, { value: 'haul-away', label: 'Haul away' }, { value: 'none', label: 'None' }, { value: 'unknown', label: 'TBD' }]} onChange={(v) => set((x) => { x.disposal = v; })} /></Field>
        </div>
        <div className="card col">
          <h3>Site conditions</h3>
          <Field label="Access constraints"><input className="input" value={dm.accessConstraints ?? ''} onChange={(e) => set((x) => { x.accessConstraints = e.target.value; })} placeholder="e.g. backyard only through side gate, slope" /></Field>
          <Field label="Narrowest gate / access width"><LengthInput defaultUnit="in" value={dm.narrowGateWidthIn} onChange={(v) => set((x) => { x.narrowGateWidthIn = v; })} /></Field>
          <Field label="Material staging"><input className="input" value={dm.staging ?? ''} onChange={(e) => set((x) => { x.staging = e.target.value; })} /></Field>
          <Field label="Equipment"><input className="input" value={dm.equipment ?? ''} onChange={(e) => set((x) => { x.equipment = e.target.value; })} /></Field>
          <Toggle label="Turf protection" checked={!!dm.turfProtection} onChange={(v) => set((x) => { x.turfProtection = v; })} />
          <div className="grid">
            <Field label="Permit"><Segmented value={dm.permitRequired} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'unknown', label: 'TBD' }]} onChange={(v) => set((x) => { x.permitRequired = v; })} /></Field>
            <Field label="HOA approval"><Segmented value={dm.hoaApproval} options={[{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }, { value: 'unknown', label: 'TBD' }]} onChange={(v) => set((x) => { x.hoaApproval = v; })} /></Field>
          </div>
        </div>
      </div>
      <div className="card col">
        <div className="row"><h3 style={{ flex: 1, margin: 0 }}>Allowances (not measured)</h3><button className="btn small" onClick={() => set((x) => { x.allowances.push({ id: uid().slice(0, 6), label: 'Allowance', amount: 0 }); })}>＋ Allowance</button></div>
        {dm.allowances.map((a, i) => (
          <div key={a.id} className="row">
            <input className="input" style={{ flex: 2 }} value={a.label} onChange={(e) => set((x) => { x.allowances[i].label = e.target.value; })} />
            <div style={{ flex: 1 }}><NumberInput value={a.amount} unit="$" onChange={(v) => set((x) => { x.allowances[i].amount = v ?? 0; })} /></div>
            <button className="btn small danger" onClick={() => set((x) => { x.allowances.splice(i, 1); })}>Remove</button>
          </div>
        ))}
        <Field label="Unknown / concealed conditions (listed on the proposal as exclusions or allowances)"><textarea className="input" value={dm.unknownConditions ?? ''} onChange={(e) => set((x) => { x.unknownConditions = e.target.value; })} /></Field>
      </div>
      <IssueList issues={issuesFor(p, ['demolition'])} />
    </div>
  );
}

export const TECH_STEPS: StepDef[] = [
  { key: 'geometry', title: 'Geometry', area: ['geometry'], render: (p) => <GeometryStep {...p} />, done: (d) => d.geometry.shapes.length > 0 },
  { key: 'structure', title: 'Structure', area: ['structure'], render: (p) => <StructureStep {...p} />, done: (d) => !!d.structure.attachment && !!d.structure.joist.spacingIn && d.structure.beams.length > 0 },
  { key: 'footings', title: 'Footings', area: ['footings'], render: (p) => <FootingsStep {...p} />, done: (d) => d.footings.support !== 'unknown' },
  { key: 'decking', title: 'Decking & fascia', area: ['decking'], render: (p) => <DeckingStep {...p} />, done: (d) => d.alternatives.some((a) => a.deckingGroup) },
  { key: 'railing', title: 'Railing & gates', area: ['railing'], render: (p) => <RailingTechStep {...p} /> },
  { key: 'stairs', title: 'Stairs', area: ['stairs'], render: (p) => <StairsTechStep {...p} />, done: (d) => !d.consult.stairs.wanted || d.stairs.length > 0 },
  { key: 'demo', title: 'Demolition & site', area: ['demolition'], render: (p) => <DemolitionStep {...p} />, done: (d) => d.demolition.disposal !== 'unknown' },
  { key: 'review', title: 'Review & price', eyebrow: 'Final review', area: ['pricing', 'catalog', 'consultation'], render: (p) => <Review {...p} /> },
];

export { lumberDepth };
