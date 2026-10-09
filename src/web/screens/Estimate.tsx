import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { EstimateDoc, Issue } from '../../shared/types';
import { calculate, reviewAlternatives, type EstimateResult } from '../../engine';
import { Nav, useMe } from '../components/Shell';
import { useEstimate } from '../lib/useEstimate';
import { useRefData, type RefData } from '../lib/refdata';
import { money } from '../lib/api';
import { SaveBadge, Segmented, Sheet, useToast } from '../components/ui';
import { CONSULT_STEPS } from './estimate/Consult';
import { TECH_STEPS } from './estimate/Technical';

export interface StepProps {
  doc: EstimateDoc;
  update: (m: (d: EstimateDoc) => void) => void;
  result: EstimateResult;
  refData: RefData;
  meta: any;
  estimateId: string;
  refreshMeta: () => Promise<void>;
  readOnly: boolean;
}

export interface StepDef { key: string; title: string; eyebrow?: string; area?: Issue['area'][]; render: (p: StepProps) => JSX.Element; done?: (d: EstimateDoc) => boolean; hidden?: (d: EstimateDoc) => boolean }

export function EstimateScreen() {
  const { id = '' } = useParams();
  const me = useMe();
  const refData = useRefData();
  const store = useEstimate(id);
  const nav = useNavigate();
  const toast = useToast();
  const [confirmMode, setConfirmMode] = useState(false);
  const { doc, meta } = store;

  const update = (m: (d: EstimateDoc) => void) => store.update((d) => {
    m(d);
    // Upstream changes flag dependent selections for review (never delete them).
    d.alternatives = reviewAlternatives(d, refData.catalog);
  });

  const result = useMemo(() => (doc ? calculate(doc, refData.ctx) : null), [doc, refData.ctx]);
  if (!doc || !result) {
    return <div className="app"><Nav back="/" title="Estimate" /><main className="page">{store.status === 'error' ? <div className="issue blocker"><span className="ico">!</span>{store.error}</div> : 'Loading…'}</main></div>;
  }
  const mode = doc.ui.mode;
  const steps = (mode === 'consult' ? CONSULT_STEPS : TECH_STEPS).filter((s) => !s.hidden?.(doc));
  const idx = Math.min(mode === 'consult' ? doc.ui.consultStep : doc.ui.techStep, steps.length - 1);
  const step = steps[idx];
  const setStep = (i: number) => update((d) => { if (d.ui.mode === 'consult') d.ui.consultStep = i; else d.ui.techStep = i; window.scrollTo({ top: 0, behavior: 'smooth' }); });
  const setMode = (m: EstimateDoc['ui']['mode']) => update((d) => { d.ui.mode = m === 'review' ? 'technical' : m; if (m === 'review') d.ui.techStep = TECH_STEPS.length - 1; });
  const readOnly = store.status === 'locked';
  const allIssues = [...result.issues, ...result.alternatives.flatMap((a) => a.issues)];
  const stepIssues = (s: StepDef) => allIssues.filter((i) => s.area?.includes(i.area));
  const props: StepProps = { doc, update, result, refData, meta, estimateId: id, refreshMeta: store.refreshMeta, readOnly };
  const cust = meta?.customer;

  return (
    <div className="app">
      <Nav back={cust ? `/customers/${cust.id}` : '/'} title={<span>{cust?.name ?? 'Estimate'} <span className="sub" style={{ fontWeight: 400 }}>· {meta?.estimate?.title} · Rev {meta?.revisions?.find((r: any) => r.id === meta?.current?.id)?.number ?? ''}</span></span>}
        right={<div className="row" style={{ gap: 8 }}>
          <SaveBadge status={store.status} lastSavedAt={store.lastSavedAt} error={store.error} />
          <Segmented value={mode === 'technical' && idx === TECH_STEPS.length - 1 ? 'review' : mode} options={[{ value: 'consult', label: 'With customer' }, { value: 'technical', label: 'Measure & build' }, { value: 'review', label: 'Review' }]} onChange={(m) => (m === 'technical' && mode === 'consult' ? setConfirmMode(true) : setMode(m as any))} />
        </div>} />
      {readOnly && (
        <div className="issue review" style={{ margin: '12px 16px 0', borderRadius: 12 }}>
          <span className="ico">i</span>
          <div style={{ flex: 1 }}>This revision was sent to the customer and is frozen. Create a new revision to make changes — the sent proposal stays exactly as it was.</div>
          <button className="btn small primary" onClick={() => store.newRevision('Revision after proposal').catch((e) => toast(e.message))}>Create revision</button>
        </div>
      )}
      <div className="workspace">
        <aside className="rail">
          <div className="section-title" style={{ marginTop: 4 }}>{mode === 'consult' ? 'Consultation' : 'Measure & build'}</div>
          {steps.map((s, i) => {
            const iss = stepIssues(s);
            const cls = i === idx ? 'on' : iss.some((x) => x.severity === 'blocker') && mode === 'technical' ? 'warn' : s.done?.(doc) ? 'done' : '';
            return <button key={s.key} className={cls} onClick={() => setStep(i)}><span className="num">{s.done?.(doc) && i !== idx ? '✓' : i + 1}</span>{s.title}</button>;
          })}
        </aside>
        <section className="stage">
          <div className="stage-head">
            <div className="eyebrow">{step.eyebrow ?? (mode === 'consult' ? `Step ${idx + 1} of ${steps.length}` : `Technical ${idx + 1} of ${steps.length}`)}</div>
            <h1>{step.title}</h1>
          </div>
          <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {step.render(props)}
          </fieldset>
        </section>
      </div>
      <footer className="bottom-bar">
        <button className="btn" disabled={idx === 0} onClick={() => setStep(idx - 1)}>‹ Back</button>
        <div className="spacer" />
        <PricePreview result={result} />
        <div className="spacer" />
        {idx < steps.length - 1 ? <button className="btn primary" onClick={() => setStep(idx + 1)}>{mode === 'consult' ? 'Next' : 'Continue'} ›</button>
          : mode === 'consult' ? <button className="btn primary" onClick={() => setConfirmMode(true)}>Start measuring ›</button>
          : <button className="btn primary" onClick={() => nav(`/customers/${cust?.id}`)}>Done</button>}
      </footer>

      <Sheet open={confirmMode} onClose={() => setConfirmMode(false)} title="Switch to technical mode?" footer={<><button className="btn" onClick={() => setConfirmMode(false)}>Stay with customer</button><button className="btn primary" onClick={() => { setConfirmMode(false); setMode('technical'); }}>Start measuring</button></>}>
        <p>Everything the customer chose is saved on this estimate. Technical mode uses the same project — you can come back to the consultation at any time.</p>
        <p className="sub">{doc.alternatives.filter((a) => a.status !== 'removed').length} option(s) selected for comparison.</p>
      </Sheet>

      <Sheet open={!!store.conflict} onClose={() => undefined} title="This estimate changed on another device"
        footer={<><button className="btn" onClick={() => store.resolveConflict('theirs')}>Use the other device's version</button><button className="btn primary" onClick={() => store.resolveConflict('mine')}>Keep my changes</button></>}>
        <p>{store.conflict?.updatedBy ?? 'Someone'} saved a newer version{store.conflict?.updatedAt ? ` at ${new Date(store.conflict.updatedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''} while you had unsaved changes on this device.</p>
        <ConflictSummary mine={store.conflict?.mine} theirs={store.conflict?.theirs} />
        <p className="small">Nothing is overwritten until you choose. "Keep my changes" replaces the other version; "Use the other device's version" discards this device's unsaved edits.</p>
      </Sheet>
      {me && null}
    </div>
  );
}

function ConflictSummary({ mine, theirs }: { mine?: EstimateDoc; theirs?: EstimateDoc }) {
  if (!mine || !theirs) return null;
  const sections: [string, (d: EstimateDoc) => unknown][] = [['Consultation choices', (d) => d.consult], ['Options', (d) => d.alternatives], ['Geometry', (d) => d.geometry], ['Structure', (d) => d.structure], ['Footings', (d) => d.footings], ['Decking', (d) => d.decking], ['Stairs', (d) => d.stairs], ['Demolition & site', (d) => d.demolition], ['Overrides', (d) => d.overrides]];
  const diff = sections.filter(([, f]) => JSON.stringify(f(mine)) !== JSON.stringify(f(theirs))).map(([n]) => n);
  return <div className="row" style={{ gap: 6 }}>{diff.length ? diff.map((d) => <span key={d} className="pill orange">{d} differ</span>) : <span className="pill">Only view position differs</span>}</div>;
}

function PricePreview({ result }: { result: EstimateResult }) {
  const alts = result.alternatives;
  if (!alts.length) return <div className="price-chip"><b>—</b><span>Choose a product to see pricing</span></div>;
  return (
    <div className="row" style={{ gap: 18, flexWrap: 'nowrap', overflowX: 'auto' }}>
      {alts.slice(0, 3).map((a) => {
        const priced = a.totals.materialSell + a.totals.laborSell + a.totals.allowances;
        const final = a.complete && a.totals.total !== null;
        return (
          <div key={a.alternative.id} className="price-chip" title={final ? 'Complete estimate' : 'Preliminary — some quantities or prices are not yet known'}>
            <b>{final ? money(a.totals.total) : priced > 0 ? `${money(priced)}+` : '—'}</b>
            <span>{a.alternative.name.slice(0, 22)} · {final ? 'final' : priced > 0 ? 'preliminary' : result.geometry.valid ? 'needs pricing' : 'needs measurements'}</span>
          </div>
        );
      })}
    </div>
  );
}
