import { describe, expect, it } from 'vitest';
import {
  allocate, baseJoistLines, calculate, computeGeometry, computeRailing, computeStair, footingConcrete, formatFtIn, isComplete,
  parseLength, reviewAlternatives, totals, unitSell, arcAccuracy,
} from '../src/engine';
import type { CatalogItem, Shape } from '../src/shared/types';
import { completeDoc, rectDoc, testCatalog, testTax, verifiedTestRules } from './fixtures';

const ctx = { catalog: testCatalog, catalogVersion: 'test-1', rules: verifiedTestRules, tax: testTax };
const rect = (id: string, x: number, y: number, wFt: number, hFt: number): Shape => ({ id, label: id, kind: 'rect', x, y, w: wFt * 12, h: hFt * 12 });

describe('units', () => {
  it('parses field lengths with fractional inches', () => {
    expect(parseLength(`16'`)).toBe(192);
    expect(parseLength(`16' 3 1/2"`)).toBe(195.5);
    expect(parseLength('16-3 1/2')).toBe(195.5);
    expect(parseLength('3 1/2"')).toBe(3.5);
    expect(parseLength('7/16"')).toBeCloseTo(0.4375, 10);
    expect(parseLength('20', 'ft')).toBe(240);
    expect(parseLength('16.25ft')).toBe(195);
    expect(parseLength('abc')).toBeNull();
  });
  it('formats inches back to feet-inches', () => {
    expect(formatFtIn(195.5)).toBe(`16' 3 1/2"`);
    expect(formatFtIn(192)).toBe(`16'`);
    expect(formatFtIn(0.4375)).toBe(`7/16"`);
  });
});

describe('geometry', () => {
  it('16 ft × 20 ft = exactly 320 sq ft before waste', () => {
    const g = computeGeometry([rect('A', 0, 0, 16, 20)]);
    expect(g.areaSqFt).toBe(320);
    expect(g.perimeterIn / 12).toBe(72);
  });
  it('rectangle + triangle uses base × height ÷ 2 and does not count the shared edge', () => {
    const tri: Shape = { id: 'T', label: 'T', kind: 'triangle', x: 0, y: 144, base: 192, height: 48, apexOffset: 96 };
    const g = computeGeometry([rect('A', 0, 0, 16, 12), tri]);
    expect(g.areaSqFt).toBeCloseTo(224, 9);
    const slant = Math.hypot(96, 48);
    expect(g.perimeterIn).toBeCloseTo(192 + 144 * 2 + slant * 2, 6);
  });
  it('overlapping areas are unioned (no double counting)', () => {
    const g = computeGeometry([rect('A', 0, 0, 10, 10), rect('B', 60, 0, 10, 10)]);
    expect(g.areaSqFt).toBeCloseTo(150, 9);
    expect(g.grossShapeAreaSqIn / 144).toBeCloseTo(200, 9);
    expect(g.perimeterIn / 12).toBeCloseTo(50, 9);
  });
  it('adjacent areas sharing an edge do not inflate perimeter', () => {
    const g = computeGeometry([rect('A', 0, 0, 10, 10), rect('B', 120, 0, 10, 10)]);
    expect(g.areaSqFt).toBeCloseTo(200, 9);
    expect(g.perimeterIn / 12).toBeCloseTo(60, 9);
  });
  it('cutouts are subtracted', () => {
    const g = computeGeometry([rect('A', 0, 0, 16, 20)], [rect('C', 24, 24, 2, 2)]);
    expect(g.areaSqFt).toBeCloseTo(316, 9);
  });
  it('rejects self-intersecting polygons', () => {
    const bow: Shape = { id: 'P', label: 'Bowtie', kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 100, y: 0 }, { x: 0, y: 100 }] };
    const g = computeGeometry([bow]);
    expect(g.valid).toBe(false);
    expect(g.issues.some((i) => i.severity === 'blocker' && /intersects itself/.test(i.message))).toBe(true);
  });
  it('polygon area via shoelace (L-shape)', () => {
    const L: Shape = { id: 'L', label: 'L', kind: 'polygon', points: [{ x: 0, y: 0 }, { x: 240, y: 0 }, { x: 240, y: 120 }, { x: 120, y: 120 }, { x: 120, y: 240 }, { x: 0, y: 240 }] };
    expect(computeGeometry([L]).areaSqFt).toBeCloseTo(300, 9);
  });
  it('curves carry an explicit approximation label and converge', () => {
    const arc = { id: 'C', label: 'Curve', kind: 'arc' as const, p1: { x: 0, y: 0 }, p2: { x: 120, y: 0 }, sagitta: 30, segments: 32 };
    const acc = arcAccuracy(arc);
    expect(acc.errorPct).toBeGreaterThan(0);
    expect(acc.errorPct).toBeLessThan(0.5);
    const g = computeGeometry([arc]);
    expect(g.issues.some((i) => /approximated by 32/.test(i.message))).toBe(true);
  });
});

describe('framing', () => {
  it('20 ft width at 16" max spacing gives 16 base joist lines', () => {
    expect(baseJoistLines(240, 16)).toBe(16);
  });
  it('engine reproduces the fixture and keeps rims/extra framing separate', () => {
    const d = completeDoc();
    d.geometry.shapes = [{ id: 'A', label: 'A', kind: 'rect', x: 0, y: 0, w: 240, h: 144, heightIn: 36 }];
    const r = calculate(d, ctx);
    expect(r.framing!.baseLineCount).toBe(16);
    expect(r.framing!.joistCuts).toHaveLength(16);
    expect(r.framing!.joistCuts.every((c) => c.lengthIn === 144)).toBe(true);
    // ledger at house edge, one rim at the far edge; side edges are the boundary joists (not counted twice)
    expect(r.framing!.ledgerCuts).toHaveLength(1);
    expect(r.framing!.rimCuts).toHaveLength(1);
    expect(r.framing!.extraJoistCuts).toHaveLength(0);
  });
  it('L-shape adds a boundary joist at the inside corner as EXTRA framing', () => {
    const d = completeDoc();
    d.geometry.shapes = [{ id: 'L', label: 'L', kind: 'polygon', heightIn: 36, points: [{ x: 0, y: 0 }, { x: 250, y: 0 }, { x: 250, y: 120 }, { x: 130, y: 120 }, { x: 130, y: 240 }, { x: 0, y: 240 }] }];
    d.geometry.edgeTags = { 'L:0': { side: 'house', ledger: true } };
    const r = calculate(d, ctx);
    expect(r.framing!.extraJoistCuts.some((c) => c.reason.includes('inside corner'))).toBe(true);
  });
  it('flags unsupported spans and missing inputs instead of passing', () => {
    const d = completeDoc();
    d.structure.beams[0].offsetIn = 200; // beyond deck
    d.structure.joist.spacingIn = undefined;
    const r = calculate(d, ctx);
    expect(isComplete(r).complete).toBe(false);
    expect(r.issues.some((i) => i.id === 'joist-spacing-missing')).toBe(true);
  });
  it('brick veneer ledger is a blocker; unverified rules block verification', () => {
    const d = completeDoc();
    d.structure.ledger.substrate = 'brick-veneer';
    const r = calculate(d, { ...ctx, rules: null });
    expect(r.issues.some((i) => i.id === 'ledger-brick' && i.severity === 'blocker')).toBe(true);
    expect(r.issues.some((i) => i.id === 'rules-unverified')).toBe(true);
    expect(r.framing!.structuralVerified).toBe(false);
  });
  it('overspan against the verified table is a blocker', () => {
    const d = completeDoc();
    d.geometry.shapes = [rect('A', 0, 0, 16, 20)];
    (d.geometry.shapes[0] as any).heightIn = 36;
    d.structure.beams[0].offsetIn = 228; // 19' joist span > 180"
    const r = calculate(d, ctx);
    expect(r.issues.some((i) => i.id === 'joist-overspan')).toBe(true);
  });
  it('post count follows the beam layout, not deck size', () => {
    const r = calculate(completeDoc(), ctx);
    expect(r.framing!.beams[0].posts).toBe(3); // ceil(192/96)+1
    const d = completeDoc();
    d.structure.beams[0].postSpacingIn = 72;
    expect(calculate(d, ctx).framing!.beams[0].posts).toBe(4); // ceil(192/72)+1
  });
});

describe('decking takeoff', () => {
  it('rows, cuts and stock mapping trace to geometry', () => {
    const r = calculate(completeDoc(), ctx);
    const a = r.alternatives[0];
    expect(a.decking!.rows).toBe(26); // ceil((144 + .25)/5.75)
    const line = a.lines.find((l) => l.key === 'decking:TB-16')!;
    expect(line.purchaseQty).toBe(26);
    expect(a.decking!.fieldAllocation!.boards.every((b) => b.cuts.length === 1)).toBe(true);
  });
  it('changing direction changes the takeoff', () => {
    const d = completeDoc();
    d.geometry.deckingAngleDeg = 90;
    d.geometry.joistAngleDeg = 0;
    const r = calculate(d, ctx);
    expect(r.alternatives[0].decking!.rows).toBe(34);
    expect(r.alternatives[0].lines.find((l) => l.key === 'decking:TB-12')!.purchaseQty).toBe(34);
  });
  it('picture frame reduces the field and adds border boards', () => {
    const d = completeDoc();
    d.decking.pictureFrameCourses = 1;
    const a = calculate(d, ctx).alternatives[0];
    expect(a.decking!.rows).toBe(24);
    expect(a.decking!.frameCuts.map((c) => Math.round(c.lengthIn)).sort()).toEqual([144, 144, 192, 192]);
    expect(a.lines.some((l) => l.key.startsWith('frame:'))).toBe(true);
  });
  it('clip count = exact board–joist crossings, packed by box size', () => {
    const a = calculate(completeDoc(), ctx).alternatives[0];
    expect(a.decking!.crossings).toBe(26 * 13);
    const clip = a.lines.find((l) => l.key === 'fastener:CLIP-90')!;
    expect(clip.calcQty).toBe(338);
    expect(clip.purchaseQty).toBe(4);
  });
  it('fascia follows selected edges and board height; off removes it', () => {
    const d = completeDoc();
    const on = calculate(d, ctx).alternatives[0].lines.filter((l) => l.group === 'Fascia');
    expect(on.length).toBeGreaterThan(0);
    d.consult.fascia = false;
    expect(calculate(d, ctx).alternatives[0].lines.filter((l) => l.group === 'Fascia')).toHaveLength(0);
  });
  it('decking product joist-spacing requirement is enforced', () => {
    const d = completeDoc();
    d.alternatives[0].deckingGroup = 'TESTBRAND2|Line B|Brown';
    const a = calculate(d, ctx).alternatives[0];
    expect(a.issues.some((i) => i.id.startsWith('deck-joist-spacing'))).toBe(true);
  });
  it('allocation reuses offcuts and is traceable', () => {
    const al = allocate([{ id: 'a', lengthIn: 100 }, { id: 'b', lengthIn: 40 }, { id: 'c', lengthIn: 40 }], [{ lengthIn: 144, sku: 'S12' }], { kerfIn: 0.125, minReusableIn: 24 });
    expect(al.boards).toHaveLength(2);
    expect(al.boards[0].cuts.map((c) => c.id)).toEqual(['a', 'b']);
  });
  it('cuts longer than stock create seams', () => {
    const al = allocate([{ id: 'x', lengthIn: 300 }], [{ lengthIn: 240 }], { kerfIn: 0, minReusableIn: 24 });
    expect(al.seams).toBe(1);
  });
});

describe('railing', () => {
  it('attached on one side: rails on 3 exposed edges, shared corner posts counted once', () => {
    const a = calculate(completeDoc(), ctx).alternatives[0];
    expect(a.railing!.totalLengthIn).toBeCloseTo(480, 6);
    expect(a.railing!.sections).toBe(6);
    expect(a.railing!.posts).toBe(7); // 6 + 1, not 9
    expect(a.railing!.sharedCornerPosts).toBe(2);
  });
  it('gate and stair openings split runs and are excluded from rail length', () => {
    const d = completeDoc();
    d.geometry.openings = [
      { id: 'g1', kind: 'gate', edgeKey: 'A:2', offsetIn: 48, widthIn: 36 },
      { id: 's1', kind: 'stair', edgeKey: 'A:1', offsetIn: 48, widthIn: 48, stairId: 'st1' },
    ];
    const a = calculate(d, ctx).alternatives[0];
    expect(a.railing!.totalLengthIn).toBeCloseTo(480 - 36 - 48, 6);
    expect(a.railing!.openingsApplied.map((o) => o.id).sort()).toEqual(['g1', 's1']);
    expect(a.railing!.runs.length).toBe(3);
    expect(a.lines.find((l) => l.key === 'gate:GATE-1')!.purchaseQty).toBe(1);
  });
  it('a closed loop of railing uses Σ sections posts', () => {
    const g = computeGeometry([rect('A', 0, 0, 8, 8)]);
    const tags = { 'A:0': { side: 'open' as const, rail: true }, 'A:1': { side: 'open' as const, rail: true }, 'A:2': { side: 'open' as const, rail: true }, 'A:3': { side: 'open' as const, rail: true } };
    const r = computeRailing(g, tags, [], testCatalog.filter((c) => c.category === 'railing-section'));
    expect(r.sections).toBe(4);
    expect(r.posts).toBe(4);
  });
  it('shared edges between areas do not get railing', () => {
    const g = computeGeometry([rect('A', 0, 0, 10, 10), rect('B', 120, 0, 10, 10)]);
    const tags: any = {};
    for (const k of ['A:0', 'A:1', 'A:2', 'A:3', 'B:0', 'B:1', 'B:2', 'B:3']) tags[k] = { side: 'open', rail: true };
    const r = computeRailing(g, tags, [], testCatalog.filter((c) => c.category === 'railing-section'));
    expect(r.totalLengthIn / 12).toBeCloseTo(60, 6);
  });
  it('incompatible railing parts are blocked', () => {
    const cat: CatalogItem[] = [...testCatalog, { id: 'x1', sku: 'OTHER-CAP', description: 'Other cap', category: 'railing-accessory', purchaseUnit: 'each', active: true, cost: 1, sale: { method: 'markup', pct: 10 }, spec: { railingSystem: 'TestRail', compatibleSystems: ['OtherRail'], per: 'post' } }];
    const a = calculate(completeDoc(), { ...ctx, catalog: cat }).alternatives[0];
    expect(a.issues.some((i) => i.id === 'rail-incompatible-OTHER-CAP' && i.severity === 'blocker')).toBe(true);
  });
});

describe('stairs and footings', () => {
  it('stair math traces to rise and verified rules', () => {
    const r = computeStair({ id: 's', label: 'Stair', totalRiseIn: 36, widthIn: 48, treadDepthIn: 10.5, topConvention: 'deck-top', railsLeft: true, railsRight: true, riserBoards: true }, verifiedTestRules, { widthIn: 5.5, gapIn: 0.25 });
    expect(r.risers).toBe(5);
    expect(r.actualRiseIn).toBeCloseTo(7.2, 9);
    expect(r.treads).toBe(4);
    expect(r.totalRunIn).toBeCloseTo(42, 9);
    expect(r.stringers).toBe(4);
    expect(r.treadBoardsPerTread).toBe(2);
    expect(r.complete).toBe(true);
  });
  it('missing finished elevation blocks stair calculation', () => {
    const r = computeStair({ id: 's', label: 'Stair', widthIn: 48, treadDepthIn: 10.5, topConvention: 'deck-top', railsLeft: false, railsRight: false, riserBoards: false }, verifiedTestRules, {});
    expect(r.complete).toBe(false);
    expect(r.issues[r.issues.length - 1].severity).toBe('blocker');
  });
  it('low stairs still get guard/handrail checks', () => {
    const r = computeStair({ id: 's', label: 'Stair', totalRiseIn: 14, widthIn: 48, treadDepthIn: 11, topConvention: 'deck-top', railsLeft: false, railsRight: false, riserBoards: false }, null, {});
    expect(r.issues.some((i) => i.id.startsWith('stair-guard'))).toBe(true);
    expect(r.complete).toBe(false);
  });
  it('footing concrete: volume from dimensions, bags from product yield, waste separate', () => {
    const f = footingConcrete({ shape: 'round', diameterIn: 12, depthIn: 30 }, 3, 0.6, 10);
    expect(f.eachCuFt).toBeCloseTo((Math.PI * 36 * 30) / 1728, 9);
    expect(f.bags).toBe(11);
    const r = calculate(completeDoc(), ctx);
    expect(r.alternatives[0].lines.find((l) => l.key === 'concrete:CONC-80')!.purchaseQty).toBe(11);
  });
  it('existing footings need a recorded inspection', () => {
    const d = completeDoc();
    d.footings.support = 'existing-footings';
    expect(calculate(d, ctx).issues.some((i) => i.id === 'footing-reuse')).toBe(true);
  });
});

describe('pricing', () => {
  it('markup and margin are distinct formulas', () => {
    const base = { id: 'p', sku: 'P', description: 'P', category: 'other' as const, purchaseUnit: 'each' as const, active: true, cost: 10 };
    expect(unitSell({ ...base, sale: { method: 'markup', pct: 50 } })).toBeCloseTo(15, 9);
    expect(unitSell({ ...base, sale: { method: 'margin', pct: 40 } })).toBeCloseTo(16.6667, 3);
  });
  it('missing prices are never zero and block completion', () => {
    const cat = testCatalog.map((c) => (c.sku === 'TB-16' ? { ...c, cost: undefined } : c));
    const r = calculate(completeDoc(), { ...ctx, catalog: cat });
    const a = r.alternatives[0];
    expect(a.lines.find((l) => l.key === 'decking:TB-16')!.status).toBe('needs-pricing');
    expect(a.totals.total).toBeNull();
    expect(isComplete(r).complete).toBe(false);
  });
  it('unconfigured tax blocks a final total', () => {
    const r = calculate(completeDoc(), { ...ctx, tax: { configured: false } });
    expect(r.alternatives[0].totals.total).toBeNull();
    expect(r.alternatives[0].issues.some((i) => i.id === 'tax-unconfigured')).toBe(true);
  });
  it('a complete estimate has a total and no blockers', () => {
    const r = calculate(completeDoc(), ctx);
    const blockers = isComplete(r).blockers;
    expect(blockers.map((b) => b.message)).toEqual([]);
    expect(r.alternatives[0].totals.total).toBeGreaterThan(0);
    const t = r.alternatives[0].totals;
    expect(t.materialSell).toBeGreaterThan(t.materialCost);
  });
  it('totals: discount and tax on materials', () => {
    const t = totals([{ key: 'm', kind: 'material', group: 'Other', description: '', unit: 'ea', calcQty: 1, purchaseQty: 1, effectiveQty: 1, formula: '', inputs: {}, status: 'ok', extCost: 50, extSell: 100 }], { discountPct: 10, tax: { configured: true, ratePct: 6, base: 'materials' } });
    expect(t.totals.discount).toBe(10);
    expect(t.totals.tax).toBeCloseTo(5.4, 9);
    expect(t.totals.total).toBeCloseTo(95.4, 9);
  });
});

describe('overrides and alternatives', () => {
  it('quantity overrides are preserved with computed value and survive recalculation', () => {
    const d = completeDoc();
    d.overrides['decking:TB-16'] = { value: 30, reason: 'Customer wants spare boards', by: 'sam', at: '2026-10-09' };
    const l = calculate(d, ctx).alternatives[0].lines.find((x) => x.key === 'decking:TB-16')!;
    expect(l.purchaseQty).toBe(26);
    expect(l.effectiveQty).toBe(30);
    d.geometry.shapes = [rect('A', 0, 0, 16, 14)];
    (d.geometry.shapes[0] as any).heightIn = 36;
    const l2 = calculate(d, ctx).alternatives[0].lines.find((x) => x.key === 'decking:TB-16')!;
    expect(l2.purchaseQty).toBe(30); // ceil((168+.25)/5.75)=30 rows
    expect(l2.effectiveQty).toBe(30);
    expect(l2.override?.reason).toBe('Customer wants spare boards');
  });
  it('area override keeps computed value and flags missing layout', () => {
    const d = completeDoc();
    d.geometry.areaOverride = { value: 200, reason: 'Customer sketch', by: 'sam', at: 'x' };
    const r = calculate(d, ctx);
    expect(r.area.computedSqFt).toBe(192);
    expect(r.area.effectiveSqFt).toBe(200);
    d.geometry.shapes = [];
    const r2 = calculate(d, ctx);
    expect(r2.issues.some((i) => i.id === 'area-override-no-geo')).toBe(true);
  });
  it('wood and multiple composite alternatives price from the same geometry', () => {
    const d = completeDoc();
    d.consult.materials.wood = true;
    d.alternatives.push({ id: 'alt2', name: 'Pressure-treated', kind: 'wood', deckingGroup: 'WOOD|PT|Natural', fasciaGroup: 'TESTBRAND|Fascia|Gray', railingSystem: 'TestRail', status: 'active' });
    const r = calculate(d, ctx);
    expect(r.alternatives).toHaveLength(2);
    expect(r.alternatives[0].lines.some((l) => l.key === 'decking:TB-16')).toBe(true);
    expect(r.alternatives[1].lines.some((l) => l.key === 'decking:WD-16')).toBe(true);
    expect(r.alternatives[1].lines.some((l) => l.key === 'fastener:CLIP-W')).toBe(true);
    expect(r.alternatives[0].railing!.posts).toBe(r.alternatives[1].railing!.posts);
  });
  it('upstream changes flag (not delete) dependent selections', () => {
    const d = completeDoc();
    d.consult.compositeBrands = [];
    const alts = reviewAlternatives(d, testCatalog);
    expect(alts).toHaveLength(1);
    expect(alts[0].status).toBe('needs-review');
    expect(alts[0].deckingGroup).toBe('TESTBRAND|Line A|Gray');
  });
});
