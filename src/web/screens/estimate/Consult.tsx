import type { Alternative, EstimateDoc } from '../../../shared/types';
import type { StepDef, StepProps } from '../Estimate';
import { ChoiceCard, Field, LengthInput, NumberInput, Segmented, Toggle } from '../../components/ui';
import { ElevationArt, PlanArt } from '../../components/Art';
import { compositeBrands, groupLabel, groupsOf, isComposite, isWood, railingSystems, type ProductGroup } from '../../lib/catalogView';
import { assetFor, type Asset } from '../../lib/refdata';
import { money, uid } from '../../lib/api';
import { Photos } from './Photos';

export function ProductImage({ assets, q, label }: { assets: Asset[]; q: { sku?: string; brand?: string; collection?: string; color?: string; style?: string }; label: string }) {
  const a = assetFor(assets, q);
  if (!a) return <div className="placeholder-art"><span style={{ fontSize: 26 }}>▦</span><span>{label}</span><span className="small">Product image not added — Admin › Product images</span></div>;
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <img src={`/api/assets/${a.id}/file`} alt={label} loading="lazy" />
      {a.attribution && <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10, color: '#fff', textShadow: '0 1px 2px #000' }}>© {a.attribution}</span>}
    </div>
  );
}

const Illus = ({ children }: { children: React.ReactNode }) => <div style={{ position: 'relative', width: '100%', height: '100%' }}>{children}<span style={{ position: 'absolute', left: 8, bottom: 6, fontSize: 10, color: 'var(--text-3)' }}>Illustration</span></div>;

const priceHint = (g: ProductGroup) => {
  const it = g.items.find((i) => i.cost !== undefined);
  if (!g.priced) return <span className="pill orange">Needs pricing</span>;
  if (g.demo) return <span className="pill orange">Demo data</span>;
  return it ? null : null;
};

function toggleAlt(d: EstimateDoc, kind: 'wood' | 'composite', g: ProductGroup) {
  const existing = d.alternatives.find((a) => a.deckingGroup === g.group && a.status !== 'removed');
  if (existing) { existing.status = 'removed'; return; }
  const revived = d.alternatives.find((a) => a.deckingGroup === g.group && a.status === 'removed');
  if (revived) { revived.status = 'active'; return; }
  const alt: Alternative = { id: `alt-${uid().slice(0, 6)}`, name: [g.brand ?? (kind === 'wood' ? 'Wood' : ''), g.collection, g.color].filter(Boolean).join(' '), kind, brand: g.brand, deckingGroup: g.group, status: 'active' };
  // sensible defaults carried from other options
  const other = d.alternatives.find((a) => a.status !== 'removed');
  if (other) { alt.railingSystem = other.railingSystem; alt.railingColor = other.railingColor; alt.railingInfill = other.railingInfill; }
  d.alternatives.push(alt);
}

// ───────────────────────── Steps ─────────────────────────

function ProjectStep({ doc, update }: StepProps) {
  const c = doc.consult;
  const types = [
    { v: 'new', name: 'New deck', desc: 'Build a deck where there is none today.', art: <PlanArt shape="rectangle" /> },
    { v: 'replacement', name: 'Full replacement', desc: 'Remove the old deck and build new — framing, footings and surface.', art: <ElevationArt rail fascia /> },
    { v: 'resurface', name: 'Resurfacing', desc: 'Keep sound framing, replace boards, fascia and rails.', art: <PlanArt dir="h" frame={1} /> },
    { v: 'repair', name: 'Repair', desc: 'Fix specific boards, rails, stairs or framing.', art: <ElevationArt stairs rail fascia={false} /> },
  ] as const;
  return (
    <div className="col" style={{ gap: 20 }}>
      <p className="sub" style={{ marginTop: -8 }}>Let's start with what the customer has in mind. Every tap is saved to this estimate immediately.</p>
      <div className="grid big">
        {types.map((t) => <ChoiceCard key={t.v} on={c.projectType === t.v} onClick={() => update((d) => { d.consult.projectType = t.v; })} art={<Illus>{t.art}</Illus>} name={t.name} desc={t.desc} />)}
      </div>
      <div className="grid two">
        <Field label="Rough scope — in the customer's words"><textarea className="input" value={c.scopeNotes ?? ''} onChange={(e) => update((d) => { d.consult.scopeNotes = e.target.value; })} placeholder="e.g. Replace the old deck off the kitchen, about the same size, maybe add steps to the yard" /></Field>
        <div className="col">
          <Field label="Budget range (optional)">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <NumberInput value={c.budget?.min} unit="$" onChange={(v) => update((d) => { d.consult.budget = { ...d.consult.budget, min: v }; })} placeholder="From" />
              <NumberInput value={c.budget?.max} unit="$" onChange={(v) => update((d) => { d.consult.budget = { ...d.consult.budget, max: v }; })} placeholder="To" />
            </div>
          </Field>
        </div>
      </div>
    </div>
  );
}

function MaterialStep({ doc, update }: StepProps) {
  const m = doc.consult.materials;
  return (
    <div className="col" style={{ gap: 20 }}>
      <p className="sub" style={{ marginTop: -8 }}>Choose one or both. Each choice opens its own products and creates its own priced option — the customer can compare wood with one or more composite brands side by side.</p>
      <div className="grid two">
        <ChoiceCard on={m.wood} onClick={() => update((d) => { d.consult.materials.wood = !d.consult.materials.wood; })} art={<Illus><PlanArt material="wood" dir="h" /></Illus>} name="Wood"
          desc={<>Natural look and lower upfront cost. Needs periodic cleaning and staining/sealing. Species, grade and finish shown next.</>} />
        <ChoiceCard on={m.composite} onClick={() => update((d) => { d.consult.materials.composite = !d.consult.materials.composite; })} art={<Illus><PlanArt material="composite" dir="h" frame={1} /></Illus>} name="Composite"
          desc={<>Low maintenance — no staining, resists rot and splinters. Higher upfront cost. Brands, collections and colors next.</>} />
      </div>
    </div>
  );
}

function ProductsStep({ doc, update, refData }: StepProps) {
  const c = doc.consult;
  const configured = refData.settings?.brands?.composite ?? [];
  const brands = compositeBrands(refData.catalog, configured);
  const woodGroups = groupsOf(refData.catalog, 'decking', isWood);
  const selected = new Set(doc.alternatives.filter((a) => a.status !== 'removed').map((a) => a.deckingGroup));
  return (
    <div className="col" style={{ gap: 8 }}>
      {!c.materials.wood && !c.materials.composite && <div className="issue review"><span className="ico">?</span>Choose wood and/or composite in the previous step.</div>}
      {c.materials.wood && <>
        <div className="section-title">Wood — tap to add to the comparison</div>
        {woodGroups.length === 0 ? <div className="card small">No wood decking is in the price list yet. Import your lumber price list in Admin › Price lists (species, grade, finish and stock lengths).</div> : (
          <div className="grid">
            {woodGroups.map((g) => (
              <ChoiceCard key={g.group} compact on={selected.has(g.group)} onClick={() => update((d) => toggleAlt(d, 'wood', g))}
                art={<ProductImage assets={refData.assets} q={{ brand: g.brand, collection: g.collection, color: g.color }} label={groupLabel(g.group)} />}
                name={[g.collection, g.color].filter(Boolean).join(' · ') || groupLabel(g.group)} desc={<>{g.profile ?? ''} {g.widthIn ? `${g.widthIn}" wide` : ''} · {g.lengths.join(', ')} ft</>} badge={priceHint(g)} />
            ))}
          </div>
        )}
        <div className="grid" style={{ marginTop: 8 }}>
          <Field label="Species preference"><input className="input" value={c.wood.species ?? ''} onChange={(e) => update((d) => { d.consult.wood.species = e.target.value; })} placeholder="e.g. pressure-treated pine, cedar" /></Field>
          <Field label="Grade"><input className="input" value={c.wood.grade ?? ''} onChange={(e) => update((d) => { d.consult.wood.grade = e.target.value; })} /></Field>
          <Field label="Finish"><input className="input" value={c.wood.finish ?? ''} onChange={(e) => update((d) => { d.consult.wood.finish = e.target.value; })} placeholder="e.g. semi-transparent stain" /></Field>
        </div>
      </>}
      {c.materials.composite && <>
        <div className="section-title">Composite brands — select one or more to compare</div>
        <div className="grid">
          {brands.map((b) => {
            const on = c.compositeBrands.includes(b);
            const n = groupsOf(refData.catalog, 'decking', (i) => i.brand === b && isComposite(i)).length;
            return <ChoiceCard key={b} compact on={on} onClick={() => update((d) => { d.consult.compositeBrands = on ? d.consult.compositeBrands.filter((x) => x !== b) : [...d.consult.compositeBrands, b]; })}
              art={<ProductImage assets={refData.assets} q={{ brand: b }} label={b} />} name={b} desc={n ? `${n} color/collection options in your price list` : 'Not in your price list yet'} />;
          })}
        </div>
        {c.compositeBrands.map((b) => {
          const groups = groupsOf(refData.catalog, 'decking', (i) => i.brand === b && isComposite(i));
          const byCollection = new Map<string, ProductGroup[]>();
          for (const g of groups) { const k = g.collection ?? 'Other'; byCollection.set(k, [...(byCollection.get(k) ?? []), g]); }
          return (
            <div key={b}>
              <div className="section-title">{b} — tap colors to add them as options</div>
              {groups.length === 0 ? <div className="card small">{b} products are not in the imported price list. Add them via Admin › Price lists; the customer's interest is still recorded.</div> : [...byCollection.entries()].map(([col, gs]) => (
                <div key={col} style={{ marginBottom: 14 }}>
                  <h3>{col}</h3>
                  <div className="grid">
                    {gs.map((g) => (
                      <ChoiceCard key={g.group} compact on={selected.has(g.group)} onClick={() => update((d) => toggleAlt(d, 'composite', g))}
                        art={<ProductImage assets={refData.assets} q={{ brand: g.brand, collection: g.collection, color: g.color }} label={`${g.color ?? ''}`} />}
                        name={g.color ?? groupLabel(g.group)} desc={<>{[g.texture, g.profile].filter(Boolean).join(' · ')} {g.lengths.length ? `· ${g.lengths.join('/')} ft` : ''}</>} badge={priceHint(g)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </>}
      {refData.packages.length > 0 && <>
        <div className="section-title">Packages — tap to add as options</div>
        <div className="grid">
          {refData.packages.filter((pk: any) => (pk.kind === 'wood' ? c.materials.wood : c.materials.composite)).map((pk: any) => {
            const on = doc.alternatives.some((a) => a.packageId === pk.id && a.status !== 'removed');
            return <ChoiceCard key={pk.id} compact on={on} onClick={() => update((d) => {
              const ex = d.alternatives.find((a) => a.packageId === pk.id);
              if (ex) { ex.status = ex.status === 'removed' ? 'active' : 'removed'; return; }
              d.alternatives.push({ id: `alt-${uid().slice(0, 6)}`, name: `${pk.tier} — ${pk.name}`, kind: pk.kind, brand: pk.brand, deckingGroup: pk.deckingGroup, fasciaGroup: pk.fasciaGroup, railingSystem: pk.railingSystem, railingColor: pk.railingColor, packageId: pk.id, status: 'active' });
              if (pk.brand && pk.kind === 'composite' && !d.consult.compositeBrands.includes(pk.brand)) d.consult.compositeBrands.push(pk.brand);
            })} art={<ProductImage assets={refData.assets} q={{ brand: pk.brand }} label={pk.name} />} name={`${pk.tier} · ${pk.name}`} desc={<>{groupLabel(pk.deckingGroup)}{pk.includes ? ` — ${pk.includes}` : ''}</>} />;
          })}
        </div>
      </>}
      <AlternativesSummary doc={doc} update={update} />
    </div>
  );
}

function AlternativesSummary({ doc, update }: Pick<StepProps, 'doc' | 'update'>) {
  const alts = doc.alternatives.filter((a) => a.status !== 'removed');
  if (!alts.length) return null;
  return (
    <>
      <div className="section-title">Options for this customer ({alts.length})</div>
      <div className="group">
        {alts.map((a) => (
          <div key={a.id} className="item">
            <span className="pill" style={{ background: a.kind === 'wood' ? 'rgba(176,122,69,.18)' : 'var(--fill)' }}>{a.kind}</span>
            <input className="input" style={{ flex: 1, minHeight: 38, padding: '6px 10px' }} value={a.name} onChange={(e) => update((d) => { d.alternatives.find((x) => x.id === a.id)!.name = e.target.value; })} />
            {a.status === 'needs-review' && <span className="pill orange" title={a.reviewReasons?.join('\n')}>Needs review</span>}
            <button className="btn small danger" onClick={() => update((d) => { d.alternatives.find((x) => x.id === a.id)!.status = 'removed'; })}>Remove</button>
          </div>
        ))}
      </div>
      {alts.some((a) => a.status === 'needs-review') && <div className="small" style={{ marginTop: 6 }}>Options marked "Needs review" are kept, not deleted — an earlier answer changed. {alts.filter((a) => a.reviewReasons).map((a) => `${a.name}: ${a.reviewReasons!.join('; ')}`).join(' · ')}</div>}
    </>
  );
}

function ShapeStep({ doc, update }: StepProps) {
  const c = doc.consult;
  const shapes = [
    ['rectangle', 'Rectangle', 'Simple and efficient.'], ['l-shape', 'L-shape', 'Wraps a corner or creates two zones.'], ['multi-area', 'Multiple areas', 'Separate dining and lounge spaces.'],
    ['wraparound', 'Wraparound', 'Follows the house on several sides.'], ['curved', 'Curved edge', 'A soft radius on the outside edge.'], ['custom', 'Custom / angled', 'Clipped corners, angles, anything else.'],
  ] as const;
  const dirs = [
    ['parallel-house', 'Parallel to the house', 'Classic and most economical.', 'h', 0, 90, 'straight'],
    ['perpendicular', 'Away from the house', 'Draws the eye out to the yard. Changes framing.', 'v', 90, 0, 'straight'],
    ['diagonal', 'Diagonal', 'Striking look; usually needs closer joists and more waste.', 'diag', 45, 90, 'diagonal'],
  ] as const;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="section-title">Shape</div>
      <div className="grid">
        {shapes.map(([v, n, desc]) => <ChoiceCard key={v} compact on={c.shape === v} onClick={() => update((d) => { d.consult.shape = v; })} art={<Illus><PlanArt shape={v} material={c.materials.wood && !c.materials.composite ? 'wood' : 'composite'} /></Illus>} name={n} desc={desc} />)}
      </div>
      <div className="section-title">Decking direction</div>
      <div className="grid">
        {dirs.map(([v, n, desc, art, deck, joist, pattern]) => <ChoiceCard key={v} compact on={c.deckingDirection === v} onClick={() => update((d) => { d.consult.deckingDirection = v; d.geometry.deckingAngleDeg = deck; d.geometry.joistAngleDeg = joist; d.decking.pattern = pattern; })} art={<Illus><PlanArt dir={art} /></Illus>} name={n} desc={desc} />)}
      </div>
      <Field label="Design inspiration & notes"><textarea className="input" value={c.inspiration ?? ''} onChange={(e) => update((d) => { d.consult.inspiration = e.target.value; })} placeholder="e.g. Saw a neighbor's deck with a darker border; wants room for a 6-person table and a grill" /></Field>
    </div>
  );
}

function FrameStep({ doc, update, refData }: StepProps) {
  const pf = doc.consult.pictureFrame;
  const opts = [['none', 'No border', 0, 'Boards run edge to edge; ends are cut flush.'], ['single', 'Single border', 1, 'One board runs around the edge, hiding board ends. A contrasting color frames the deck.'], ['double', 'Double border', 2, 'Two border courses for a bolder, more finished look.'], ['custom', 'Custom border', 3, 'Inlays, three courses or a special pattern — note it below.']] as const;
  const alts = doc.alternatives.filter((a) => a.status !== 'removed');
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="grid">
        {opts.map(([v, n, courses, desc]) => <ChoiceCard key={v} compact on={pf === v} onClick={() => update((d) => { d.consult.pictureFrame = v; d.decking.pictureFrameCourses = (v === 'custom' ? Math.max(1, d.decking.pictureFrameCourses) : courses) as 0 | 1 | 2 | 3; })} art={<Illus><PlanArt frame={courses > 2 ? 2 : courses} /></Illus>} name={n} desc={desc} />)}
      </div>
      {pf === 'custom' && <Field label="Courses"><Segmented value={doc.decking.pictureFrameCourses} options={[{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }]} onChange={(v) => update((d) => { d.decking.pictureFrameCourses = v as 1 | 2 | 3; })} /></Field>}
      {pf && pf !== 'none' && alts.length > 0 && <>
        <div className="section-title">Border color for each option</div>
        {alts.map((a) => {
          const groups = groupsOf(refData.catalog, 'decking', (i) => (a.kind === 'wood' ? isWood(i) : i.brand === a.brand));
          return (
            <div key={a.id} className="card flat" style={{ marginBottom: 8 }}>
              <div className="row"><b style={{ flex: 1 }}>{a.name}</b>
                <select className="input" style={{ maxWidth: 360 }} value={a.frameGroup ?? a.deckingGroup ?? ''} onChange={(e) => update((d) => { d.alternatives.find((x) => x.id === a.id)!.frameGroup = e.target.value; })}>
                  {groups.map((g) => <option key={g.group} value={g.group}>{g.group === a.deckingGroup ? `Same as field — ${g.color}` : groupLabel(g.group)}</option>)}
                </select>
              </div>
            </div>
          );
        })}
      </>}
      <Field label="Border notes"><input className="input" value={doc.consult.pictureFrameNotes ?? ''} onChange={(e) => update((d) => { d.consult.pictureFrameNotes = e.target.value; })} /></Field>
    </div>
  );
}

function FasciaStep({ doc, update, refData }: StepProps) {
  const f = doc.consult.fascia;
  const alts = doc.alternatives.filter((a) => a.status !== 'removed');
  return (
    <div className="col" style={{ gap: 8 }}>
      <p className="sub" style={{ marginTop: -8 }}>Fascia is the finished board that covers the outside of the frame (the rim joist) — the part you see from the yard.</p>
      <div className="grid two">
        <ChoiceCard on={f === true} onClick={() => update((d) => { d.consult.fascia = true; })} art={<Illus><ElevationArt fascia rail={doc.consult.railing.wanted} /></Illus>} name="With fascia" desc="Clean, finished edge in a matching or contrasting color. Hides lumber and protects the rim." />
        <ChoiceCard on={f === false} onClick={() => update((d) => { d.consult.fascia = false; })} art={<Illus><ElevationArt fascia={false} rail={doc.consult.railing.wanted} /></Illus>} name="No fascia" desc="Exposed pressure-treated framing. Lower cost; the frame stays visible and weathers." />
      </div>
      {f && alts.length > 0 && <>
        <div className="section-title">Fascia product for each option</div>
        {alts.map((a) => {
          const groups = groupsOf(refData.catalog, 'fascia', (i) => i.profile !== 'Riser' && (a.kind === 'wood' ? true : !i.brand || i.brand === a.brand));
          return (
            <div key={a.id} className="card flat" style={{ marginBottom: 8 }}>
              <div className="row"><b style={{ flex: 1 }}>{a.name}</b>
                {groups.length === 0 ? <span className="pill orange">No fascia in price list</span> : (
                  <select className="input" style={{ maxWidth: 360 }} value={a.fasciaGroup ?? ''} onChange={(e) => update((d) => { d.alternatives.find((x) => x.id === a.id)!.fasciaGroup = e.target.value || undefined; })}>
                    <option value="">Choose fascia…</option>
                    {groups.map((g) => <option key={g.group} value={g.group}>{groupLabel(g.group)}</option>)}
                  </select>
                )}
              </div>
            </div>
          );
        })}
      </>}
    </div>
  );
}

function RailingStep({ doc, update, refData }: StepProps) {
  const r = doc.consult.railing;
  const systems = railingSystems(refData.catalog);
  const alts = doc.alternatives.filter((a) => a.status !== 'removed');
  const current = alts[0];
  const sys = systems.find((s) => s.name === current?.railingSystem);
  const setAll = (patch: Partial<Alternative>) => update((d) => { for (const a of d.alternatives) if (a.status !== 'removed') Object.assign(a, patch); });
  const style = (s?: string): 'balusters' | 'cable' | 'glass' => (s?.toLowerCase().includes('cable') ? 'cable' : s?.toLowerCase().includes('glass') ? 'glass' : 'balusters');
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="grid two">
        <ChoiceCard on={r.wanted === true} onClick={() => update((d) => { d.consult.railing.wanted = true; })} art={<Illus><ElevationArt rail fascia={!!doc.consult.fascia} /></Illus>} name="Railing" desc="Guards around the open edges. Choose a system, style, infill and color." />
        <ChoiceCard on={r.wanted === false} onClick={() => update((d) => { d.consult.railing.wanted = false; })} art={<Illus><ElevationArt fascia={!!doc.consult.fascia} /></Illus>} name="No railing" desc="Only where not required — low decks are still checked in technical mode." />
      </div>
      {r.wanted && <>
        <div className="section-title">Railing system</div>
        {systems.length === 0 ? <div className="card small">No railing systems are in the price list yet. Import section kits with their system name, max span and colors in Admin › Price lists.</div> : (
          <div className="grid">
            {systems.map((s) => <ChoiceCard key={s.name} compact on={current?.railingSystem === s.name} onClick={() => setAll({ railingSystem: s.name, railingColor: s.colors.includes(current?.railingColor ?? '') ? current?.railingColor : s.colors[0] })}
              art={<ProductImage assets={refData.assets} q={{ brand: s.brand, collection: s.name, style: undefined }} label={s.name} />} name={s.name} desc={<>{s.material ?? ''} · {s.colors.length} colors{!s.hasPost ? ' · posts missing in catalog' : ''}{!s.hasGate ? ' · no gate kit' : ''}</>} />)}
          </div>
        )}
        {sys && <>
          <div className="section-title">Color</div>
          <div className="grid">
            {sys.colors.map((col) => <ChoiceCard key={col} compact on={current?.railingColor === col} onClick={() => setAll({ railingColor: col })} art={<ProductImage assets={refData.assets} q={{ collection: sys.name, color: col }} label={`${sys.name} ${col}`} />} name={col} />)}
          </div>
          {sys.infill.length > 0 && <Field label="Infill"><Segmented value={current?.railingInfill} options={sys.infill.map((i) => ({ value: i, label: i }))} onChange={(v) => setAll({ railingInfill: v })} /></Field>}
          <div className="card flat" style={{ padding: 0, overflow: 'hidden', maxWidth: 520 }}><div style={{ aspectRatio: '16/10' }}><ElevationArt rail railStyle={style(current?.railingInfill ?? sys.name)} fascia={!!doc.consult.fascia} lights={!!doc.consult.extras.lighting.postCap} /></div></div>
        </>}
        <div className="grid two">
          <Field label="Style notes"><input className="input" value={r.style ?? ''} onChange={(e) => update((d) => { d.consult.railing.style = e.target.value; })} placeholder="e.g. black aluminum, slim balusters" /></Field>
          <Field label="Height preference"><LengthInput defaultUnit="in" value={r.heightIn} onChange={(v) => update((d) => { d.consult.railing.heightIn = v; })} placeholder={`e.g. 36"`} /></Field>
        </div>
        {alts.length > 1 && <div className="small">The same railing is applied to every option; you can change it per option in Review.</div>}
      </>}
    </div>
  );
}

function GatesStep({ doc, update }: StepProps) {
  const g = doc.consult.gates;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="grid two">
        <ChoiceCard on={g.wanted === true} onClick={() => update((d) => { d.consult.gates.wanted = true; d.consult.gates.count ??= 1; })} art={<Illus><ElevationArt rail gate /></Illus>} name="Add a gate" desc="Matches the selected railing system. Great for kids, pets or a stair landing." />
        <ChoiceCard on={g.wanted === false} onClick={() => update((d) => { d.consult.gates.wanted = false; })} art={<Illus><ElevationArt rail /></Illus>} name="No gate" />
      </div>
      {g.wanted && <div className="grid two">
        <Field label="How many gates"><NumberInput value={g.count} min={1} onChange={(v) => update((d) => { d.consult.gates.count = v; })} /></Field>
        <Field label="Location, width and style" hint="Place the exact gate opening on the sketch in technical mode."><input className="input" value={g.notes ?? ''} onChange={(e) => update((d) => { d.consult.gates.notes = e.target.value; })} placeholder="e.g. top of the stairs, 36&quot; self-closing" /></Field>
      </div>}
    </div>
  );
}

function StairsConsultStep({ doc, update }: StepProps) {
  const s = doc.consult.stairs;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="grid two">
        <ChoiceCard on={s.wanted === true} onClick={() => update((d) => { d.consult.stairs.wanted = true; })} art={<Illus><ElevationArt stairs rail /></Illus>} name="Stairs" desc="Down to the yard or patio. We'll measure the rise and design them in technical mode." />
        <ChoiceCard on={s.wanted === false} onClick={() => update((d) => { d.consult.stairs.wanted = false; })} art={<Illus><ElevationArt rail /></Illus>} name="No stairs" />
      </div>
      {s.wanted && <div className="grid two">
        <Field label="Rough location"><input className="input" value={s.location ?? ''} onChange={(e) => update((d) => { d.consult.stairs.location = e.target.value; })} placeholder="e.g. right side toward the driveway" /></Field>
        <Field label="Desired width"><LengthInput value={s.approxWidthIn} onChange={(v) => update((d) => { d.consult.stairs.approxWidthIn = v; })} /></Field>
        <Field label="Configuration"><Segmented value={s.configuration} options={[{ value: 'straight', label: 'Straight' }, { value: 'landing', label: 'With landing' }, { value: 'l-turn', label: 'L-turn' }, { value: 'wide', label: 'Wide / box steps' }]} onChange={(v) => update((d) => { d.consult.stairs.configuration = v; })} /></Field>
        <Field label="Landing at the bottom"><Segmented value={s.landing} options={[{ value: 'concrete-pad', label: 'Concrete pad' }, { value: 'pavers', label: 'Pavers' }, { value: 'gravel', label: 'Gravel' }, { value: 'existing', label: 'Existing' }]} onChange={(v) => update((d) => { d.consult.stairs.landing = v; })} /></Field>
      </div>}
    </div>
  );
}

function ExtrasStep({ doc, update }: StepProps) {
  const x = doc.consult.extras;
  const set = (m: (e: EstimateDoc['consult']['extras']) => void) => update((d) => m(d.consult.extras));
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="grid">
        <ChoiceCard compact on={!!x.skirting} onClick={() => set((e) => { e.skirting = !e.skirting; })} art={<Illus><ElevationArt skirting /></Illus>} name="Skirting" desc="Closes the space under the deck." />
        <ChoiceCard compact on={x.underDeck === 'drainage'} onClick={() => set((e) => { e.underDeck = e.underDeck === 'drainage' ? 'none' : 'drainage'; })} art={<Illus><ElevationArt under="drainage" /></Illus>} name="Under-deck drainage" desc="Keeps the space below dry." />
        <ChoiceCard compact on={x.underDeck === 'ceiling'} onClick={() => set((e) => { e.underDeck = e.underDeck === 'ceiling' ? 'none' : 'ceiling'; })} art={<Illus><ElevationArt under="ceiling" /></Illus>} name="Under-deck ceiling" desc="Finished ceiling for the patio below." />
        <ChoiceCard compact on={!!x.lighting.postCap} onClick={() => set((e) => { e.lighting.postCap = !e.lighting.postCap; })} art={<Illus><ElevationArt rail lights /></Illus>} name="Post-cap lights" />
        <ChoiceCard compact on={!!x.lighting.stair} onClick={() => set((e) => { e.lighting.stair = !e.lighting.stair; })} art={<Illus><ElevationArt stairs lights rail /></Illus>} name="Stair / riser lights" />
        <ChoiceCard compact on={!!x.postCaps} onClick={() => set((e) => { e.postCaps = !e.postCaps; })} art={<Illus><ElevationArt rail /></Illus>} name="Decorative post caps" />
        <ChoiceCard compact on={!!x.concretePad} onClick={() => set((e) => { e.concretePad = !e.concretePad; })} art={<Illus><ElevationArt pad stairs /></Illus>} name="Concrete pad / patio below" />
        <ChoiceCard compact on={!!x.coveredOrScreened} onClick={() => set((e) => { e.coveredOrScreened = !e.coveredOrScreened; })} art={<Illus><ElevationArt covered rail /></Illus>} name="Covered / screened" desc={<span className="pill orange">Separately scoped</span>} />
      </div>
      {x.coveredOrScreened && <div className="issue info"><span className="ico">i</span>Roofs, covers and screen rooms are recorded as a separately scoped request — this estimator does not price them.</div>}
      <Field label="Other upgrades requested"><input className="input" value={x.other ?? ''} onChange={(e) => set((ex) => { ex.other = e.target.value; })} /></Field>
    </div>
  );
}

function NotesStep(p: StepProps) {
  const c = p.doc.consult;
  const u = p.update;
  return (
    <div className="col" style={{ gap: 14 }}>
      <Photos {...p} />
      <div className="grid two">
        <Field label="Customer notes (appear on the proposal and contract)"><textarea className="input" value={c.customerNotes ?? ''} onChange={(e) => u((d) => { d.consult.customerNotes = e.target.value; })} /></Field>
        <Field label="Priorities"><textarea className="input" value={c.priorities ?? ''} onChange={(e) => u((d) => { d.consult.priorities = e.target.value; })} placeholder="e.g. low maintenance, finish before July 4th" /></Field>
        <Field label="Alternatives the customer asked to see"><textarea className="input" value={c.alternativesRequested ?? ''} onChange={(e) => u((d) => { d.consult.alternativesRequested = e.target.value; })} /></Field>
        <Field label="Internal notes (never shown to the customer)"><textarea className="input" value={p.doc.internalNotes ?? ''} onChange={(e) => u((d) => { d.internalNotes = e.target.value; })} /></Field>
      </div>
      <OptionsPreview {...p} />
    </div>
  );
}

function OptionsPreview({ result }: StepProps) {
  if (!result.alternatives.length) return null;
  return (
    <>
      <div className="section-title">Where pricing stands</div>
      <div className="grid">
        {result.alternatives.map((a) => (
          <div key={a.alternative.id} className="card">
            <b>{a.alternative.name}</b>
            <div className="price-big" style={{ fontSize: 26 }}>{a.complete ? money(a.totals.total) : '—'}</div>
            <div className="small">{a.complete ? 'Complete' : result.geometry.valid ? 'Preliminary — finish measurements and resolve open items' : 'Measurements needed before a price can be shown'}</div>
          </div>
        ))}
      </div>
    </>
  );
}

export const CONSULT_STEPS: StepDef[] = [
  { key: 'project', title: 'Project', render: (p) => <ProjectStep {...p} />, done: (d) => !!d.consult.projectType },
  { key: 'material', title: 'Wood or composite', render: (p) => <MaterialStep {...p} />, done: (d) => d.consult.materials.wood || d.consult.materials.composite },
  { key: 'products', title: 'Products & colors', render: (p) => <ProductsStep {...p} />, done: (d) => d.alternatives.some((a) => a.status !== 'removed') },
  { key: 'shape', title: 'Shape & layout', render: (p) => <ShapeStep {...p} />, done: (d) => !!d.consult.shape && !!d.consult.deckingDirection },
  { key: 'frame', title: 'Picture frame', render: (p) => <FrameStep {...p} />, done: (d) => !!d.consult.pictureFrame },
  { key: 'fascia', title: 'Fascia', render: (p) => <FasciaStep {...p} />, done: (d) => d.consult.fascia !== undefined },
  { key: 'railing', title: 'Railing', render: (p) => <RailingStep {...p} />, done: (d) => d.consult.railing.wanted !== undefined },
  { key: 'gates', title: 'Gates', render: (p) => <GatesStep {...p} />, done: (d) => d.consult.gates.wanted !== undefined, hidden: (d) => d.consult.railing.wanted === false },
  { key: 'stairs', title: 'Stairs', render: (p) => <StairsConsultStep {...p} />, done: (d) => d.consult.stairs.wanted !== undefined },
  { key: 'extras', title: 'Upgrades', render: (p) => <ExtrasStep {...p} />, done: (d) => Object.values(d.consult.extras).some((v) => v && v !== 'none' && (typeof v !== 'object' || Object.values(v).some(Boolean))) },
  { key: 'notes', title: 'Photos & notes', render: (p) => <NotesStep {...p} />, done: (d) => !!(d.consult.customerNotes || d.consult.priorities) },
];

export { Toggle };
