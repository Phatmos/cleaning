/**
 * Estimate assembler: geometry → structure → takeoff → pricing → presentation.
 * Each layer is a separate module; this file only wires them together and turns
 * their results into traceable BOM lines.
 */
import type { Alternative, BomLine, CatalogItem, EstimateDoc, Issue, LaborMap, PricingPolicy, RuleSet } from '../shared/types';
import { allocate, type Allocation, type Stock } from './allocate';
import { computeDecking, computeFascia, type DeckingResult } from './decking';
import { computeFraming, type FramingResult } from './framing';
import { computeGeometry, type GeometryResult } from './geometry';
import { priceLines, totals, type PricedLine, type TaxConfig, type Totals } from './pricing';
import { computeRailing, railingCompatibility, type RailingResult } from './railing';
import { computeStair, footingConcrete, type StairResult } from './stairs';
import { sqInToSqFt } from './units';

export const ENGINE_VERSION = 'engine-1.0.0';

export interface CalcContext {
  catalog: CatalogItem[];
  catalogVersion: string;
  rules: RuleSet | null;
  tax: TaxConfig;
  laborMap?: LaborMap;
  policy?: PricingPolicy;
}

export interface AltResult {
  alternative: Alternative;
  lines: PricedLine[];
  totals: Totals;
  issues: Issue[];
  decking?: DeckingResult;
  railing?: RailingResult;
  stairs: StairResult[];
  complete: boolean;
}

export interface EstimateResult {
  engineVersion: string;
  catalogVersion: string;
  rulesVersion: string;
  geometry: GeometryResult;
  area: { computedSqFt: number; effectiveSqFt: number; override?: EstimateDoc['geometry']['areaOverride'] };
  perimeterFt: number;
  framing?: FramingResult;
  issues: Issue[];
  alternatives: AltResult[];
}

export const groupItems = (catalog: CatalogItem[], group?: string, category?: string) =>
  group ? catalog.filter((c) => c.active && c.group === group && (!category || c.category === category)) : [];

const stocksOf = (items: CatalogItem[]): Stock[] =>
  items.filter((i) => i.stockLengthIn && i.stockLengthIn > 0).map((i) => ({ lengthIn: i.stockLengthIn!, sku: i.sku, catalogId: i.id }));

/** Dimensional lumber by nominal size. 2x6 stock may be catalogued as wood decking; it is the same board. */
const lumber = (catalog: CatalogItem[], cats: string[], size?: string) =>
  size ? catalog.filter((c) => c.active && c.profile === size && (cats.includes(c.category) || (c.category === 'decking' && c.material === 'wood'))) : [];

export function calculate(doc: EstimateDoc, ctx: CalcContext): EstimateResult {
  const issues: Issue[] = [];
  const geo = computeGeometry(doc.geometry.shapes, doc.geometry.cutouts);
  issues.push(...geo.issues);
  const rulesVersion = ctx.rules ? `${ctx.rules.id}@v${ctx.rules.version} (${ctx.rules.status})` : 'none';
  const computedSqFt = geo.areaSqFt;
  const ao = doc.geometry.areaOverride;
  if (ao) issues.push({ id: 'area-override', severity: 'review', area: 'geometry', message: `Area overridden to ${ao.value} sq ft (computed ${computedSqFt.toFixed(2)}): ${ao.reason}`, hint: 'An area override does not provide board layout, spans or perimeter — those still come from the measured outline.' });
  const base: EstimateResult = {
    engineVersion: ENGINE_VERSION, catalogVersion: ctx.catalogVersion, rulesVersion, geometry: geo,
    area: { computedSqFt, effectiveSqFt: ao ? ao.value : computedSqFt, override: ao }, perimeterFt: geo.perimeterIn / 12, issues, alternatives: [],
  };
  if (!geo.valid) {
    if (ao) issues.push({ id: 'area-override-no-geo', severity: 'blocker', area: 'geometry', message: 'Only an area override exists — board layout, joists, perimeter and railing need measured geometry' });
    base.alternatives = activeAlts(doc).map((a) => ({ alternative: a, lines: [], totals: emptyTotals(), issues: [], stairs: [], complete: false }));
    return base;
  }
  const consult = doc.consult;
  const tags = doc.geometry.edgeTags;
  const framing = computeFraming(geo, doc.geometry.joistAngleDeg, doc.structure, tags, ctx.rules, { pictureFrameCourses: doc.decking.pictureFrameCourses });
  base.framing = framing;
  issues.push(...framing.issues);

  // Footings
  const footingIssues: Issue[] = [];
  const f = doc.footings;
  if (f.support === 'unknown') footingIssues.push({ id: 'footing-support', severity: 'blocker', area: 'footings', message: 'Support/footing type not answered' });
  if (f.support === 'existing-footings' || f.support === 'existing-concrete') {
    const ins = f.reuseInspection;
    if (!ins || !ins.approved || !ins.dimensionsKnown)
      footingIssues.push({ id: 'footing-reuse', severity: 'blocker', area: 'footings', message: 'Reusing existing footings/concrete requires a recorded inspection with known dimensions and approval' });
  }
  if (f.support === 'new-footings' && !f.bearingAssumptionPsf) footingIssues.push({ id: 'footing-bearing', severity: 'review', area: 'footings', message: 'Soil bearing assumption not recorded — footing size not verified' });
  issues.push(...footingIssues);

  for (const s of doc.stairs) if (!doc.geometry.openings.some((o) => o.stairId === s.id)) issues.push({ id: `stair-opening-${s.id}`, severity: 'review', area: 'stairs', message: `${s.label} is not placed on a deck edge (railing opening not applied)` });
  if (consult.extras.coveredOrScreened) issues.push({ id: 'covered-separate', severity: 'info', area: 'consultation', message: 'Covered/screened structure requested — separately scoped item, not priced by this estimator' });

  const catalogById = new Map(ctx.catalog.map((c) => [c.id, c]));
  for (const alt of activeAlts(doc)) base.alternatives.push(calcAlternative(doc, alt, ctx, geo, framing, catalogById));
  return base;
}

const activeAlts = (doc: EstimateDoc) => doc.alternatives.filter((a) => a.status !== 'removed');

function emptyTotals(): Totals {
  return { materialCost: 0, laborCost: 0, materialSell: 0, laborSell: 0, allowances: 0, projectMarkup: 0, commission: 0, subtotal: 0, discount: 0, taxable: 0, tax: null, total: null, needsPricing: [], marginPct: null, markupPct: null };
}

function calcAlternative(doc: EstimateDoc, alt: Alternative, ctx: CalcContext, geo: GeometryResult, framing: FramingResult, catalogById: Map<string, CatalogItem>): AltResult {
  const issues: Issue[] = [];
  const lines: PricedLine[] = [];
  const cat = ctx.catalog;
  const sv = `${ENGINE_VERSION}; catalog ${ctx.catalogVersion}`;
  const tags = doc.geometry.edgeTags;

  const push = (l: Omit<PricedLine, 'effectiveQty' | 'status' | 'sourceVersion'> & { status?: BomLine['status'] }) => {
    const ov = doc.overrides[l.key];
    lines.push({ ...l, status: l.status ?? 'ok', sourceVersion: sv, override: ov, effectiveQty: ov ? ov.value : l.purchaseQty });
  };
  const fromAllocation = (keyPrefix: string, group: BomLine['group'], label: string, a: Allocation, extraWastePct: number, inputs: Record<string, number | string>) => {
    for (const s of a.byStock) {
      const item = s.catalogId ? catalogById.get(s.catalogId) : undefined;
      const extra = Math.ceil(s.count * (extraWastePct / 100) - 1e-9);
      push({
        key: `${keyPrefix}:${s.sku}`, group, kind: 'material', description: `${label} — ${item?.description ?? s.sku} (${s.lengthIn / 12}')`, sku: s.sku, catalogId: s.catalogId, unit: 'pc',
        calcQty: s.count, purchaseQty: s.count + extra, wastePct: extraWastePct, rounding: 'whole pieces; extra waste rounded up',
        formula: `stock allocation (${a.method}) → ${s.count} pc; + ${extraWastePct}% policy waste = ${s.count + extra}`,
        inputs: { ...inputs, cutLengthTotalIn: round(a.totalCutIn), purchasedLengthIn: round(a.totalPurchasedIn), allocationWastePct: round(a.wastePct) }, detail: a.boards.filter((b) => b.stock.lengthIn === s.lengthIn).map((b) => ({ board: b.n, cuts: b.cuts.map((c) => `${c.id} ${round(c.lengthIn)}"`), remainderIn: round(b.remainderIn) })),
      });
    }
  };

  // ── Product resolution ──
  const deckItems = groupItems(cat, alt.deckingGroup, 'decking');
  if (!alt.deckingGroup) issues.push({ id: `alt-deck-${alt.id}`, severity: 'blocker', area: 'catalog', message: `${alt.name}: decking product not selected` });
  else if (!deckItems.length) issues.push({ id: `alt-deck-missing-${alt.id}`, severity: 'blocker', area: 'catalog', message: `${alt.name}: decking product "${alt.deckingGroup}" is not in the active catalog` });
  const deck0 = deckItems[0];
  const gap = doc.decking.gapOverrideIn ?? deck0?.spec?.gapIn;
  if (deck0 && gap === undefined) issues.push({ id: `deck-gap-${alt.id}`, severity: 'review', area: 'decking', message: `${alt.name}: board gap not in product spec — 0" assumed until set` });
  if (deck0?.spec?.maxJoistSpacingIn && doc.structure.joist.spacingIn && doc.structure.joist.spacingIn > deck0.spec.maxJoistSpacingIn + 1e-9)
    issues.push({ id: `deck-joist-spacing-${alt.id}`, severity: 'blocker', area: 'decking', message: `${alt.name}: joist spacing ${doc.structure.joist.spacingIn}" exceeds ${deck0.spec.maxJoistSpacingIn}" allowed by ${deck0.description}${doc.decking.pattern === 'diagonal' ? ' (diagonal decking usually requires closer spacing — check the manufacturer)' : ''}` });

  const frameCourses = doc.decking.pictureFrameCourses;
  const frameItems = frameCourses ? groupItems(cat, alt.frameGroup ?? alt.deckingGroup, 'decking') : [];
  let decking: DeckingResult | undefined;
  if (deck0) {
    decking = computeDecking(geo, {
      deckingAngleDeg: doc.geometry.deckingAngleDeg,
      board: { widthIn: deck0.widthIn ?? 0, gapIn: gap ?? 0, stocks: stocksOf(deckItems) },
      frameBoard: frameItems.length ? { widthIn: frameItems[0].widthIn ?? 0, gapIn: frameItems[0].spec?.gapIn ?? gap ?? 0, stocks: stocksOf(frameItems) } : undefined,
      frameCourses,
      kerfIn: doc.decking.kerfIn,
      minReusableIn: doc.decking.minReusableIn,
      joist: framing.lines.length ? { n: framing.n, positions: framing.lines.map((l) => l.pos) } : undefined,
    });
    issues.push(...decking.issues);
    if (decking.fieldAllocation) fromAllocation('decking', 'Decking', 'Deck boards', decking.fieldAllocation, doc.decking.extraWastePct, { rows: decking.rows, rowFormula: decking.rowFormula, boardWidthIn: deck0.widthIn ?? 0, gapIn: gap ?? 0, angleDeg: doc.geometry.deckingAngleDeg });
    if (decking.frameAllocation) fromAllocation('frame', 'Decking', 'Picture-frame boards', decking.frameAllocation, doc.decking.extraWastePct, { courses: frameCourses });
    // Hidden fasteners / screws
    const fast = cat.find((c) => c.active && c.category === 'fastener' && c.spec?.perCrossing && (c.spec.compatibleSystems?.includes(alt.deckingGroup!) || (c.brand && c.brand === deck0.brand)));
    if (decking.crossings) {
      if (!fast) issues.push({ id: `fastener-missing-${alt.id}`, severity: 'blocker', area: 'decking', message: `${alt.name}: no compatible decking fastener configured for ${deck0.brand ?? deck0.description}` });
      else {
        const need = decking.crossings * fast.spec!.perCrossing!;
        const pack = fast.packQty ?? 1;
        push({ key: `fastener:${fast.sku}`, group: 'Hardware', kind: 'material', description: fast.description, sku: fast.sku, catalogId: fast.id, unit: fast.purchaseUnit, calcQty: need, purchaseQty: Math.ceil(need / pack - 1e-9), rounding: `packs of ${pack}, rounded up`, formula: `${decking.crossings} board–joist crossings × ${fast.spec!.perCrossing} = ${need}; ÷ ${pack}/pack`, inputs: { crossings: decking.crossings } });
      }
    }
  }

  // ── Fascia ──
  if (doc.consult.fascia) {
    const fItems = groupItems(cat, alt.fasciaGroup, 'fascia');
    if (!alt.fasciaGroup || !fItems.length) issues.push({ id: `fascia-product-${alt.id}`, severity: 'blocker', area: 'decking', message: `${alt.name}: fascia selected but no fascia product chosen` });
    else {
      const joistDepth = lumberDepth(doc.structure.joist.size);
      const fr = computeFascia(geo.edges, tags, { boardHeightIn: fItems[0].heightIn ?? fItems[0].widthIn, rimDepthIn: joistDepth, rowsOverride: doc.decking.fasciaRows });
      issues.push(...fr.issues);
      if (!fr.cuts.length) issues.push({ id: `fascia-edges-${alt.id}`, severity: 'review', area: 'decking', message: 'Fascia selected but no edges are marked for fascia' });
      else fromAllocation('fascia', 'Fascia', 'Fascia', allocate(fr.cuts, stocksOf(fItems), { kerfIn: doc.decking.kerfIn, minReusableIn: doc.decking.minReusableIn }), doc.decking.extraWastePct, { rows: fr.rows, rowsFormula: fr.formula, fasciaLf: round(fr.totalLf) });
    }
  }

  // ── Framing lumber ──
  const st = doc.structure;
  const jl = lumber(cat, ['joist'], st.joist.size);
  if (framing.joistCuts.length) {
    if (!jl.length) issues.push({ id: 'joist-lumber-missing', severity: 'blocker', area: 'structure', message: `No ${st.joist.size ?? '?'} joist lumber in catalog` });
    else {
      const jStocks = stocksOf(jl);
      // Joists are one piece per segment (no splicing): shortest stock ≥ length.
      const longest = Math.max(...jStocks.map((s) => s.lengthIn));
      const tooLong = framing.joistCuts.filter((c) => c.lengthIn > longest);
      if (tooLong.length) issues.push({ id: 'joist-too-long', severity: 'review', area: 'structure', message: `${tooLong.length} joist piece(s) longer than the longest stock (${longest / 12}') — splice over a beam requires review` });
      fromAllocation('joist', 'Framing', `Joists ${st.joist.size}`, allocate(framing.joistCuts, jStocks, { kerfIn: 0, minReusableIn: Number.POSITIVE_INFINITY }), 0, { baseLines: framing.baseLineCount, formula: framing.formula, spacingIn: st.joist.spacingIn ?? 0 });
      if (framing.extraJoistCuts.length) fromAllocation('joist-extra', 'Framing', 'Additional framing (boundary/doubled/frame)', allocate(framing.extraJoistCuts, jStocks, { kerfIn: 0, minReusableIn: Number.POSITIVE_INFINITY }), 0, { pieces: framing.extraJoistCuts.length, reasons: [...new Set(framing.extraJoistCuts.map((c) => c.reason))].join('; ') });
      if (framing.rimCuts.length) fromAllocation('rim', 'Framing', `Rim/band ${st.joist.size}`, allocate(framing.rimCuts, jStocks, { kerfIn: doc.decking.kerfIn, minReusableIn: 24 }), 0, { plies: st.joist.rimPlies });
      if (framing.ledgerCuts.length) fromAllocation('ledger', 'Framing', `Ledger ${st.joist.size}`, allocate(framing.ledgerCuts, jStocks, { kerfIn: doc.decking.kerfIn, minReusableIn: 24 }), 0, { ledgerLengthIn: round(framing.ledgerLengthIn) });
    }
    const hanger = cat.find((c) => c.active && c.category === 'hanger' && c.profile === st.joist.size);
    if (st.attachment === 'attached' && framing.ledgerLengthIn > 0) {
      const ledgerJoistEnds = framing.joistCuts.length; // one end per joist piece at the ledger
      if (!hanger) issues.push({ id: 'hanger-missing', severity: 'blocker', area: 'structure', message: `No joist hanger for ${st.joist.size ?? '?'} in catalog` });
      else push({ key: `hanger:${hanger.sku}`, group: 'Hardware', kind: 'material', description: hanger.description, sku: hanger.sku, catalogId: hanger.id, unit: 'ea', calcQty: ledgerJoistEnds, purchaseQty: Math.ceil(ledgerJoistEnds / (hanger.packQty ?? 1)), formula: '1 hanger per joist piece at the ledger', inputs: { joistPieces: framing.joistCuts.length } });
      const lf = ctx.rules?.status === 'verified' ? ctx.rules.ledgerFastening?.find((r) => r.substrate === st.ledger.substrate && Math.max(0, ...framing.spans.map((s) => s.spanIn)) <= r.joistSpanUpToIn) : undefined;
      if (!lf) issues.push({ id: 'ledger-fastening', severity: 'review', area: 'structure', message: 'Ledger fastener quantity unresolved — no verified fastening schedule for this substrate/span' });
      else {
        const qty = Math.ceil(framing.ledgerLengthIn / lf.spacingIn - 1e-9) * lf.rows;
        const item = lf.fastenerSku ? cat.find((c) => c.sku === lf.fastenerSku) : undefined;
        push({ key: `ledger-fastener:${lf.fastener}`, group: 'Hardware', kind: 'material', description: lf.fastener, sku: item?.sku, catalogId: item?.id, unit: 'ea', calcQty: qty, purchaseQty: Math.ceil(qty / (item?.packQty ?? 1)), formula: `ceil(${round(framing.ledgerLengthIn)}" ÷ ${lf.spacingIn}") × ${lf.rows} rows`, inputs: { substrate: st.ledger.substrate }, ruleRef: ctx.rules ? `${ctx.rules.id}@v${ctx.rules.version} ledgerFastening` : undefined });
      }
      const flash = cat.find((c) => c.active && c.category === 'flashing');
      if (flash && st.ledger.flashing === 'needed') {
        const lfIn = framing.ledgerLengthIn;
        const qty = flash.stockLengthIn ? Math.ceil(lfIn / flash.stockLengthIn) : Math.ceil(lfIn / 12);
        push({ key: `flashing:${flash.sku}`, group: 'Framing', kind: 'material', description: flash.description, sku: flash.sku, catalogId: flash.id, unit: flash.stockLengthIn ? 'pc' : 'lf', calcQty: qty, purchaseQty: qty, formula: flash.stockLengthIn ? `ceil(ledger ${round(lfIn)}" ÷ ${flash.stockLengthIn}" stock)` : 'ledger length in LF, rounded up', inputs: { ledgerIn: round(lfIn) } });
      }
    }
  }
  // Beams
  for (const b of framing.beams) {
    const bl = lumber(cat, ['beam', 'joist'], b.size);
    if (!bl.length) { issues.push({ id: `beam-lumber-${b.id}`, severity: 'blocker', area: 'structure', message: `No ${b.size} lumber for beam ${b.id}` }); continue; }
    const cuts = Array.from({ length: b.plies }, (_, k) => ({ id: `${b.id}-ply${k + 1}`, lengthIn: b.lengthIn, label: `Beam ${b.id} ply ${k + 1}` }));
    fromAllocation(`beam-${b.id}`, 'Framing', `Beam ${b.id} (${b.plies}-ply ${b.size})`, allocate(cuts, stocksOf(bl), { kerfIn: 0, minReusableIn: Number.POSITIVE_INFINITY }), 0, { beamLengthIn: round(b.lengthIn), plies: b.plies });
  }
  // Posts
  if (framing.postCount > 0) {
    const post = cat.filter((c) => c.active && c.category === 'post' && (!st.postSize || c.profile === st.postSize));
    const h = Math.max(0, ...doc.geometry.shapes.map((s) => s.heightIn ?? 0));
    if (!st.postSize) issues.push({ id: 'post-size', severity: 'blocker', area: 'structure', message: 'Post size not set' });
    if (!h) issues.push({ id: 'deck-height', severity: 'blocker', area: 'structure', message: 'Deck height above grade is not recorded — post lengths cannot be chosen' });
    const pick = post.filter((p) => p.stockLengthIn && p.stockLengthIn >= h).sort((a, b) => a.stockLengthIn! - b.stockLengthIn!)[0];
    if (!pick && h) issues.push({ id: 'post-stock', severity: 'blocker', area: 'structure', message: `No ${st.postSize ?? ''} post stock long enough for ${round(h / 12)}' height` });
    push({ key: `post:${pick?.sku ?? 'unresolved'}`, group: 'Framing', kind: 'material', description: pick?.description ?? `Posts ${st.postSize ?? ''}`, sku: pick?.sku, catalogId: pick?.id, unit: 'ea', calcQty: framing.postCount, purchaseQty: framing.postCount, formula: framing.beams.map((b) => `${b.id}: ${b.posts} (${b.postFormula})`).join('; '), inputs: { deckHeightIn: h }, status: pick ? 'ok' : 'needs-product' });
    for (const cn of cat.filter((c) => c.active && c.category === 'connector' && c.spec?.per === 'post' && (!c.profile || !st.postSize || c.profile === st.postSize)))
      push({ key: `post-connector:${cn.sku}`, group: 'Hardware', kind: 'material', description: cn.description, sku: cn.sku, catalogId: cn.id, unit: 'ea', calcQty: framing.postCount * (cn.spec!.perQty ?? 1), purchaseQty: Math.ceil((framing.postCount * (cn.spec!.perQty ?? 1)) / (cn.packQty ?? 1)), formula: `${framing.postCount} structural posts × ${cn.spec!.perQty ?? 1} (quantity rule from price-book import)`, inputs: {} });
    // Footings
    const f = doc.footings;
    const footCount = f.countOverride ? f.countOverride.value : framing.postCount;
    if (f.support === 'new-footings') {
      const conc = f.concreteSku ? cat.find((c) => c.sku === f.concreteSku) : undefined;
      if (!conc) issues.push({ id: 'concrete-product', severity: 'blocker', area: 'footings', message: 'Concrete product not selected' });
      const fc = footingConcrete(f.spec, footCount, conc?.yieldCuFt, f.wastePct);
      issues.push(...fc.issues);
      push({ key: `concrete:${conc?.sku ?? 'unresolved'}`, group: 'Footings', kind: 'material', description: conc?.description ?? 'Footing concrete', sku: conc?.sku, catalogId: conc?.id, unit: 'bag', calcQty: round(fc.withWasteCuFt), purchaseQty: fc.bags, wastePct: f.wastePct, rounding: 'bags rounded up', formula: fc.formula, inputs: { footings: footCount, ...(f.countOverride ? { countOverride: f.countOverride.reason } : {}) }, status: conc ? 'ok' : 'needs-product' });
      for (const hw of cat.filter((c) => c.active && c.category === 'footing-hardware' && c.spec?.per === 'post' && (!c.profile || !st.postSize || c.profile === st.postSize)))
        push({ key: `footing-hw:${hw.sku}`, group: 'Footings', kind: 'material', description: hw.description, sku: hw.sku, catalogId: hw.id, unit: 'ea', calcQty: footCount * (hw.spec!.perQty ?? 1), purchaseQty: Math.ceil((footCount * (hw.spec!.perQty ?? 1)) / (hw.packQty ?? 1)), formula: `${footCount} footings × ${hw.spec!.perQty ?? 1}`, inputs: {} });
    }
  }

  // ── Railing ──
  let railing: RailingResult | undefined;
  if (doc.consult.railing.wanted) {
    if (!alt.railingSystem) issues.push({ id: `rail-system-${alt.id}`, severity: 'blocker', area: 'railing', message: `${alt.name}: railing wanted but no railing system selected` });
    else {
      const sys = alt.railingSystem;
      const inSys = (c: CatalogItem) => c.active && c.spec?.railingSystem === sys && (!alt.railingColor || !c.spec.colors || c.spec.colors.includes(alt.railingColor));
      const kits = cat.filter((c) => c.category === 'railing-section' && inSys(c));
      railing = computeRailing(geo, tags, doc.geometry.openings, kits);
      issues.push(...railing.issues);
      if (doc.geometry.railLengthOverride) issues.push({ id: 'rail-override', severity: 'review', area: 'railing', message: `Rail length overridden to ${doc.geometry.railLengthOverride.value} ft: ${doc.geometry.railLengthOverride.reason} — section/post counts still follow the measured runs; override quantities individually if needed` });
      // Components of this system in the chosen color (other colors are simply not candidates).
      const picks = cat.filter((c) => c.active && ['railing-accessory', 'railing-post', 'gate', 'stair-rail'].includes(c.category) && c.spec?.railingSystem === sys && (!alt.railingColor || !c.spec.colors || c.spec.colors.includes(alt.railingColor)));
      issues.push(...railingCompatibility(sys, alt.railingColor, picks));
      if (railing.runs.length === 0) issues.push({ id: 'rail-no-edges', severity: 'review', area: 'railing', message: 'Railing wanted but no edges are marked for railing' });
      for (const [sku, n] of Object.entries(railing.kits)) {
        const it = kits.find((k) => k.sku === sku)!;
        push({ key: `rail-kit:${sku}`, group: 'Railing', kind: 'material', description: it.description, sku, catalogId: it.id, unit: 'kit', calcQty: n, purchaseQty: n, formula: 'Σ per leg ceil(leg length ÷ max span); smallest kit covering the installed section', inputs: { runs: railing.runs.map((r) => `${r.id} ${round(r.lengthIn / 12)}'`).join(', '), totalFt: round(railing.totalLengthIn / 12) }, detail: railing.runs });
      }
      const kitBrand = kits[0]?.brand;
      const railH = doc.consult.railing.heightIn ?? kits[0]?.heightIn ?? 36;
      const brandPosts = cat.filter((c) => c.active && c.category === 'railing-post' && !c.spec?.railingSystem && c.spec?.compatibleBrand && c.spec.compatibleBrand === kitBrand && (!alt.railingColor || !c.spec.colors || c.spec.colors.includes(alt.railingColor)));
      // shortest post taller than the guard height (e.g. 39" post for a 36" rail)
      const brandPost = brandPosts.filter((c) => (c.heightIn ?? 0) > railH).sort((a, b) => (a.heightIn ?? 0) - (b.heightIn ?? 0))[0];
      const rpost = picks.find((c) => c.category === 'railing-post') ?? brandPost;
      if (rpost && rpost === brandPost) issues.push({ id: `rail-post-compat-${alt.id}`, severity: 'review', area: 'railing', message: `${rpost.description} is matched to ${sys} by brand only — confirm post/system compatibility` });
      if (railing.posts) {
        if (!rpost) issues.push({ id: 'rail-post-missing', severity: 'blocker', area: 'railing', message: `No railing post configured for ${sys}` });
        else push({ key: `rail-post:${rpost.sku}`, group: 'Railing', kind: 'material', description: rpost.description, sku: rpost.sku, catalogId: rpost.id, unit: 'ea', calcQty: railing.posts, purchaseQty: railing.posts, formula: 'open run: Σ sections + 1; closed loop: Σ sections (shared corner posts counted once)', inputs: { sections: railing.sections, sharedCorners: railing.sharedCornerPosts } });
      }
      for (const acc of picks.filter((c) => c.category === 'railing-accessory')) {
        const per = acc.spec?.per;
        const basis = per === 'post' ? railing.posts : per === 'section' ? railing.sections : 0;
        if (!basis) continue;
        if (per === 'post' && acc.description.toLowerCase().includes('light') && !doc.consult.extras.lighting.postCap) continue;
        const q = basis * (acc.spec?.perQty ?? 1);
        push({ key: `rail-acc:${acc.sku}`, group: 'Railing', kind: 'material', description: acc.description, sku: acc.sku, catalogId: acc.id, unit: acc.purchaseUnit, calcQty: q, purchaseQty: Math.ceil(q / (acc.packQty ?? 1)), formula: `${basis} ${per}s × ${acc.spec?.perQty ?? 1}`, inputs: {} });
      }
      const gates = doc.geometry.openings.filter((o) => o.kind === 'gate');
      if (gates.length) {
        const gate = picks.find((c) => c.category === 'gate');
        if (!gate) issues.push({ id: 'gate-missing', severity: 'blocker', area: 'railing', message: `No gate kit configured for ${sys}` });
        else push({ key: `gate:${gate.sku}`, group: 'Railing', kind: 'material', description: gate.description, sku: gate.sku, catalogId: gate.id, unit: 'ea', calcQty: gates.length, purchaseQty: gates.length, formula: '1 gate kit per gate opening', inputs: { widths: gates.map((g) => `${g.widthIn}"`).join(', ') } });
      }
    }
  }

  // ── Post-cap lights & transformer ──
  let lightsUsed = false;
  if (doc.consult.extras.lighting.postCap && railing?.posts) {
    const lt = cat.find((c) => c.active && c.category === 'lighting' && c.spec?.per === 'post');
    if (!lt) issues.push({ id: 'postcap-light-missing', severity: 'blocker', area: 'railing', message: 'Post-cap lights selected but no post-cap light in the price list' });
    else { lightsUsed = true; push({ key: `postcap-light:${lt.sku}`, group: 'Lighting', kind: 'material', description: lt.description, sku: lt.sku, catalogId: lt.id, unit: 'ea', calcQty: railing.posts, purchaseQty: railing.posts, formula: `${railing.posts} railing posts × 1`, inputs: {} }); }
  }
  // ── Stairs ──
  const stairs: StairResult[] = [];
  for (const s of doc.stairs) {
    const riserItems = alt.fasciaGroup ? groupItems(cat, alt.fasciaGroup.replace(/ Fascia\|/, ' Riser|'), 'fascia') : [];
    const riserSource = riserItems.length ? riserItems : groupItems(cat, alt.fasciaGroup, 'fascia');
    const r = computeStair(s, ctx.rules, { widthIn: deck0?.widthIn, gapIn: gap }, riserSource[0]?.heightIn);
    stairs.push(r);
    issues.push(...r.issues);
    if (!r.risers) continue;
    const riserCuts = doc.consult.fascia || s.riserBoards ? r.riserCuts : [];
    if (r.treadCuts.length && deckItems.length) fromAllocation(`stair-treads-${s.id}`, 'Stairs', `${s.label} treads`, allocate(r.treadCuts, stocksOf(deckItems), { kerfIn: doc.decking.kerfIn, minReusableIn: doc.decking.minReusableIn }), doc.decking.extraWastePct, { treads: r.treads, formulas: r.formulas.join(' | ') });
    if (riserCuts.length) {
      const src = riserSource.length && stocksOf(riserSource).length ? riserSource : deckItems;
      if (src.length) fromAllocation(`stair-risers-${s.id}`, 'Stairs', `${s.label} risers`, allocate(riserCuts, stocksOf(src), { kerfIn: doc.decking.kerfIn, minReusableIn: doc.decking.minReusableIn }), doc.decking.extraWastePct, { risers: r.risers, source: src === deckItems ? 'deck boards (no riser board in price list)' : 'riser boards' });
    }
    const stringerCat = cat.filter((c) => c.active && c.category === 'stringer' && (!s.stringerSku || c.sku === s.stringerSku));
    // Without dedicated stringer stock, stringers are cut from 2x12 framing lumber.
    const stringer = stringerCat.length ? stringerCat : lumber(cat, ['joist'], '2x12');
    if (r.stringers) {
      const st0 = stringer.filter((c) => (c.stockLengthIn ?? 0) >= r.stringerLengthIn).sort((a, b) => a.stockLengthIn! - b.stockLengthIn!)[0];
      if (!st0) issues.push({ id: `stringer-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: no stringer stock ≥ ${round(r.stringerLengthIn)}"` });
      push({ key: `stringer-${s.id}:${st0?.sku ?? 'unresolved'}`, group: 'Stairs', kind: 'material', description: `${s.label} stringers — ${st0?.description ?? 'unresolved'}`, sku: st0?.sku, catalogId: st0?.id, unit: 'ea', calcQty: r.stringers, purchaseQty: r.stringers, formula: r.formulas.filter((x) => x.startsWith('stringer')).join('; '), inputs: { widthIn: s.widthIn ?? 0, stringerLengthIn: round(r.stringerLengthIn) }, status: st0 ? 'ok' : 'needs-product' });
    }
    if (r.railSides && alt.railingSystem) {
      const sr = cat.filter((c) => c.active && c.category === 'stair-rail' && c.spec?.railingSystem === alt.railingSystem && (!alt.railingColor || !c.spec?.colors || c.spec.colors.includes(alt.railingColor)) && (c.spec?.maxSpanIn ?? 0) >= r.railLengthIn / r.railSides).sort((a, b) => (a.spec!.maxSpanIn ?? 0) - (b.spec!.maxSpanIn ?? 0))[0];
      if (!sr) issues.push({ id: `stair-rail-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: no ${alt.railingSystem} stair rail kit long enough (${round(r.railLengthIn / r.railSides / 12)}')` });
      else push({ key: `stair-rail-${s.id}:${sr.sku}`, group: 'Stairs', kind: 'material', description: sr.description, sku: sr.sku, catalogId: sr.id, unit: 'kit', calcQty: r.railSides, purchaseQty: r.railSides, formula: 'one stair rail kit per railed side', inputs: { railLengthPerSideIn: round(r.railLengthIn / r.railSides) } });
    }
    if (r.lights) {
      const lt = cat.find((c) => c.active && c.category === 'lighting' && c.spec?.per === 'riser');
      lightsUsed = true;
      if (!lt) issues.push({ id: `stair-light-${s.id}`, severity: 'blocker', area: 'stairs', message: 'Stair/riser light selected but no riser light configured' });
      else push({ key: `stair-light-${s.id}:${lt.sku}`, group: 'Lighting', kind: 'material', description: lt.description, sku: lt.sku, catalogId: lt.id, unit: 'ea', calcQty: r.lights, purchaseQty: r.lights, formula: `${r.risers} risers × ${s.lightsPerRiser}`, inputs: {} });
    }
  }

  if (lightsUsed) {
    const tf = cat.find((c) => c.active && c.category === 'lighting' && c.spec?.per === 'job');
    if (tf) push({ key: `lighting-job:${tf.sku}`, group: 'Lighting', kind: 'material', description: tf.description, sku: tf.sku, catalogId: tf.id, unit: 'ea', calcQty: 1, purchaseQty: 1, formula: 'one per job with lighting', inputs: {} });
  }

  // ── Labor ──
  const areaSqFt = doc.geometry.areaOverride?.value ?? geo.areaSqFt;
  if (ctx.laborMap) {
    laborFromMap(ctx.laborMap, { doc, alt, geo, framing, railing, stairs, areaSqFt, cat, push, issues, decking, lightsUsed });
  } else {
    const laborBasis: Record<string, { qty: number; why: string }> = {
      'deck-sqft': { qty: areaSqFt, why: `deck area ${round(areaSqFt)} sq ft` },
      'rail-lf': { qty: railing ? railing.totalLengthIn / 12 : 0, why: 'railing length (ft)' },
      'stair-each': { qty: doc.stairs.length, why: 'stairs' },
      'footing-each': { qty: doc.footings.support === 'new-footings' ? (doc.footings.countOverride?.value ?? framing.postCount) : 0, why: 'new footings' },
      'demo-sqft': { qty: doc.demolition.removeDecking || doc.demolition.removeFraming ? areaSqFt : 0, why: 'demolition area' },
      'fascia-lf': { qty: doc.consult.fascia ? computeFascia(geo.edges, tags, { rowsOverride: 1 }).totalLf : 0, why: 'fascia length (ft)' },
    };
    for (const lab of cat.filter((c) => c.active && c.category === 'labor' && c.group && laborBasis[c.group] && (!c.material || c.material === alt.kind))) {
      const b = laborBasis[lab.group!];
      if (!b.qty) continue;
      push({ key: `labor:${lab.sku}`, group: 'Labor', kind: 'labor', description: lab.description, sku: lab.sku, catalogId: lab.id, unit: lab.labor?.unit ?? 'ea', calcQty: round(b.qty), purchaseQty: round(b.qty), formula: `${b.why} × configured rate`, inputs: {} });
    }
  }
  if (!cat.some((c) => c.active && c.category === 'labor')) issues.push({ id: 'labor-unconfigured', severity: 'blocker', area: 'pricing', message: 'No labor rates configured — price would exclude labor' });
  for (const cl of doc.customLines ?? []) {
    if (cl.alternativeIds?.length && !cl.alternativeIds.includes(alt.id)) continue;
    const item = cl.catalogId ? catalogById.get(cl.catalogId) : undefined;
    if (cl.catalogId && !item) { issues.push({ id: `custom-missing-${cl.id}`, severity: 'blocker', area: 'catalog', message: `Custom line "${cl.description}" refers to a price-book item that no longer exists` }); continue; }
    const isLabor = item?.category === 'labor';
    push({ key: `custom:${cl.id}`, group: isLabor ? 'Labor' : item?.allowance ? 'Allowances' : 'Other', kind: isLabor ? 'labor' : 'material', description: cl.description, sku: item?.sku, catalogId: item?.id, unit: cl.unit, calcQty: cl.qty, purchaseQty: cl.qty, formula: `added manually by ${cl.by ?? 'user'}: ${cl.reason}`, inputs: cl.internalOnly ? { internalOnly: 'yes' } : {} });
    if (!item) { const l = lines[lines.length - 1]; l.unitCost = cl.unitCost; if (cl.unitPrice !== undefined) l.priceOverride = { value: cl.unitPrice, reason: cl.reason, by: cl.by ?? '' }; }
  }
  for (const a of doc.demolition.allowances) push({ key: `allowance:${a.id}`, group: 'Allowances', kind: 'allowance', description: a.label, unit: 'allowance', calcQty: 1, purchaseQty: 1, formula: 'fixed allowance', inputs: { amount: a.amount }, extSell: a.amount, unitSell: a.amount });

  // Orphaned overrides
  for (const k of Object.keys(doc.overrides)) if (!lines.some((l) => l.key === k)) issues.push({ id: `override-orphan-${k}`, severity: 'review', area: 'pricing', message: `Override on "${k}" no longer matches a calculated line (inputs changed) — review` });
  for (const l of lines) if (l.override) issues.push({ id: `override-${l.key}`, severity: 'info', area: 'pricing', message: `${l.description}: quantity overridden ${l.purchaseQty} → ${l.override.value} by ${l.override.by} (${l.override.reason})` });
  const demo = lines.filter((l) => l.catalogId && catalogById.get(l.catalogId)?.isDemo);
  if (demo.length) issues.push({ id: `demo-items-${alt.id}`, severity: 'blocker', area: 'catalog', message: `${demo.length} line(s) use DEMO catalog data — import your real price list before sending`, hint: demo.slice(0, 4).map((l) => l.sku).join(', ') + (demo.length > 4 ? '…' : '') });

  // price overrides
  for (const l of lines) {
    const po = doc.pricing.priceOverrides[l.key];
    if (po) l.priceOverride = { value: po.value, reason: po.reason, by: po.by };
  }
  const priced = priceLines(lines, catalogById);
  const t = totals(priced, { discountPct: doc.pricing.discountPct, discountAmount: doc.pricing.discountAmount, tax: ctx.tax, policy: ctx.policy });
  issues.push(...t.issues);
  if (alt.status === 'needs-review') issues.push({ id: `alt-review-${alt.id}`, severity: 'blocker', area: 'consultation', message: `${alt.name} needs review: ${(alt.reviewReasons ?? []).join('; ')}` });
  const dedup = dedupe(issues);
  return { alternative: alt, lines: priced, totals: t.totals, issues: dedup, decking, railing, stairs, complete: !dedup.some((i) => i.severity === 'blocker') };
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>();
  return issues.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
}

/** Nominal lumber depth table (actual dressed dimension, standard US softwood sizes). */
export function lumberDepth(size?: string): number | undefined {
  const map: Record<string, number> = { '2x6': 5.5, '2x8': 7.25, '2x10': 9.25, '2x12': 11.25 };
  return size ? map[size] : undefined;
}

/** Whether an estimate result can be marked complete / sent. */
export function isComplete(r: EstimateResult, altId?: string): { complete: boolean; blockers: Issue[] } {
  const alts = altId ? r.alternatives.filter((a) => a.alternative.id === altId) : r.alternatives;
  const blockers = [...r.issues, ...alts.flatMap((a) => a.issues)].filter((i) => i.severity === 'blocker');
  return { complete: alts.length > 0 && blockers.length === 0, blockers: dedupe(blockers) };
}

/**
 * Upstream-change impact: re-check every alternative's selections against the
 * current catalog and consultation answers. Invalid choices are FLAGGED for
 * review (status = needs-review), never deleted.
 */
export function reviewAlternatives(doc: EstimateDoc, catalog: CatalogItem[]): Alternative[] {
  return doc.alternatives.map((a) => {
    if (a.status === 'removed') return a;
    const reasons: string[] = [];
    if (a.kind === 'wood' && !doc.consult.materials.wood) reasons.push('Wood was deselected in consultation');
    if (a.kind === 'composite' && !doc.consult.materials.composite) reasons.push('Composite was deselected in consultation');
    if (a.kind === 'composite' && a.brand && !doc.consult.compositeBrands.includes(a.brand)) reasons.push(`${a.brand} is no longer a selected brand`);
    if (a.deckingGroup && !groupItems(catalog, a.deckingGroup, 'decking').length) reasons.push('Selected decking is no longer in the active catalog');
    if (a.railingSystem && !doc.consult.railing.wanted) reasons.push('Railing was turned off — railing selection kept but unused');
    if (a.fasciaGroup && doc.consult.fascia === false) reasons.push('Fascia was turned off — fascia selection kept but unused');
    if (a.railingSystem && a.railingColor) {
      const kits = catalog.filter((c) => c.category === 'railing-section' && c.spec?.railingSystem === a.railingSystem);
      if (kits.length && !kits.some((k) => !k.spec?.colors || k.spec.colors.includes(a.railingColor!))) reasons.push(`Railing colour ${a.railingColor} not offered for ${a.railingSystem}`);
    }
    const blocking = reasons.filter((r) => !r.includes('kept but unused'));
    return { ...a, status: blocking.length ? 'needs-review' : 'active', reviewReasons: reasons.length ? reasons : undefined };
  });
}

const round = (x: number) => Math.round(x * 100) / 100;
export { sqInToSqFt };

/** Height tier label for the deck's highest finished surface. */
export function heightTier(map: LaborMap, heightIn: number): string | undefined {
  return map.heightTiers.find((t) => t.maxIn === null || heightIn <= t.maxIn)?.label;
}
export function stairWidthBand(map: LaborMap, widthIn: number): string | undefined {
  return map.stairWidthBands.find((b) => widthIn <= b.maxIn)?.label;
}

/**
 * Labor from the price-book labor items, selected BY NAME using the configured
 * templates (Admin › Settings › laborMap). Missing matches are reported, never
 * substituted.
 */
function laborFromMap(map: LaborMap, c: {
  doc: EstimateDoc; alt: Alternative; geo: GeometryResult; framing: FramingResult; railing?: RailingResult; stairs: StairResult[]; areaSqFt: number;
  cat: CatalogItem[]; push: (l: any) => void; issues: Issue[]; decking?: DeckingResult; lightsUsed: boolean;
}) {
  const { doc, alt, cat, push, issues } = c;
  const byName = new Map(cat.filter((i) => i.active && i.category === 'labor').map((i) => [i.description.trim().toLowerCase(), i]));
  const h = Math.max(0, ...doc.geometry.shapes.map((s) => s.heightIn ?? 0));
  const tier = h ? heightTier(map, h) : undefined;
  const fill = (tpl: string, v: Record<string, string | number | undefined>) => tpl.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? `{${k}}`));
  const add = (key: string, tpl: string | undefined, vars: Record<string, string | number | undefined>, qty: number, why: string) => {
    if (!tpl || !(qty > 0)) return;
    const name = fill(tpl, vars);
    if (/\{\w+\}/.test(name)) { issues.push({ id: `labor-input-${key}`, severity: 'blocker', area: 'pricing', message: `Labor "${tpl}" needs ${name.match(/\{(\w+)\}/)![1]} — complete the measurements` }); return; }
    const item = byName.get(name.toLowerCase());
    if (!item) { issues.push({ id: `labor-missing-${key}`, severity: 'blocker', area: 'pricing', message: `No labor item named "${name}" in the price book`, hint: 'Check Admin › Settings › laborMap or the labor price book.' }); return; }
    push({ key: `labor:${key}`, group: 'Labor', kind: 'labor', description: item.description, sku: item.sku, catalogId: item.id, unit: item.labor?.unit ?? 'each', calcQty: Math.round(qty * 100) / 100, purchaseQty: Math.round(qty * 100) / 100, formula: `${why} × labor rate`, inputs: { tier: tier ?? '—', deckHeightIn: h }, ruleRef: `laborMap.${key}` });
  };
  if (!h) issues.push({ id: 'labor-height', severity: 'blocker', area: 'pricing', message: 'Deck height is needed to choose the labor height tier' });
  const composite = alt.kind === 'composite';
  const st = doc.structure;
  add('framing', map.framing, { tier, size: st.joist.size, spacing: st.joist.spacingIn }, doc.consult.projectType === 'resurface' ? 0 : c.areaSqFt, `deck area ${Math.round(c.areaSqFt * 100) / 100} sq ft`);
  add('decking', composite ? map.deckingComposite : map.deckingWood, { tier }, c.areaSqFt, `deck area ${Math.round(c.areaSqFt * 100) / 100} sq ft`);
  if (doc.decking.pictureFrameCourses > 0 && c.decking) {
    const lf = c.decking.frameCuts.reduce((s, x) => s + x.lengthIn, 0) / 12;
    add('pictureFrame', map.pictureFrame, { tier }, lf, `picture-frame boards ${Math.round(lf * 10) / 10} lf`);
  }
  if (doc.consult.fascia) {
    const lf = computeFascia(c.geo.edges, doc.geometry.edgeTags, { rowsOverride: 1 }).totalLf;
    add('fascia', map.fasciaComposite, { tier }, lf, `fascia edges ${Math.round(lf * 10) / 10} lf`);
  }
  if (doc.demolition.removeDecking || doc.demolition.removeFraming) add('demo', map.demo, { tier }, c.areaSqFt, 'demolition area');
  if (doc.footings.support === 'new-footings') add('pier', map.pier, {}, doc.footings.countOverride?.value ?? c.framing.postCount, 'new footings');
  for (const s of c.stairs) {
    const inp = doc.stairs.find((x) => x.id === s.id);
    if (!s.risers || !inp?.widthIn) continue;
    const band = stairWidthBand(map, inp.widthIn);
    if (!band) { issues.push({ id: `labor-stair-width-${s.id}`, severity: 'blocker', area: 'pricing', message: `${s.label}: no stair labor band for ${Math.round(inp.widthIn / 12 * 10) / 10} ft width` }); continue; }
    add(`stairs-${s.id}`, composite ? map.stairsComposite : map.stairsWood, { width: band }, s.risers, `${s.label}: ${s.risers} steps (risers)`);
    if (inp.landing?.type === 'concrete-pad' && map.concretePad) {
      const n = Math.ceil(Math.max(inp.landing.widthIn, inp.landing.depthIn) / 12);
      add(`pad-${s.id}`, map.concretePad, { n: Math.max(5, n) }, 1, `${s.label} landing pad (smallest standard pad ≥ ${n} ft)`);
    }
  }
  if (c.railing && c.railing.totalLengthIn > 0 && alt.railingSystem) {
    const stairLf = c.stairs.reduce((s, x) => s + x.railLengthIn, 0) / 12;
    const lf = c.railing.totalLengthIn / 12 + stairLf;
    const tpl = map.railingBySystem[alt.railingSystem];
    if (!tpl) issues.push({ id: `labor-rail-${alt.id}`, severity: 'blocker', area: 'pricing', message: `No railing labor item mapped for "${alt.railingSystem}"`, hint: 'Add it under laborMap.railingBySystem in Admin › Settings.' });
    else add('railing', tpl, {}, lf, `railing ${Math.round(lf * 10) / 10} lf (deck + stairs)`);
    const gates = doc.geometry.openings.filter((o) => o.kind === 'gate').length;
    add('gate', map.gate, {}, gates, `${gates} gate(s)`);
  }
  if (doc.consult.extras.lighting.postCap && c.railing?.posts) add('postCapLight', map.postCapLight, {}, c.railing.posts, 'post-cap lights');
  const stairLights = c.stairs.reduce((s, x) => s + x.lights, 0);
  add('stairLight', map.stairLight, {}, stairLights, 'stair lights');
  if (c.lightsUsed) add('transformer', map.transformer, {}, 1, 'one per job with lighting');
  if (doc.structure.attachment === 'attached' && doc.structure.ledger.flashing === 'needed') add('ledgerFlashing', map.ledgerFlashing, {}, c.framing.ledgerLengthIn / 12, 'ledger length');
}
