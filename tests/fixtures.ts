/**
 * TEST-ONLY fixture data. Prices, SKUs and spans here are invented for
 * exercising the engine and are NOT company pricing or code values.
 */
import type { CatalogItem, EstimateDoc, RuleSet } from '../src/shared/types';
import { newEstimateDoc } from '../src/engine/defaults';

let n = 0;
const item = (p: Partial<CatalogItem> & Pick<CatalogItem, 'sku' | 'category'>): CatalogItem => ({
  id: `t${++n}`, description: p.sku, purchaseUnit: 'each', active: true, sale: { method: 'markup', pct: 50 }, cost: 10, ...p,
});

export const testCatalog: CatalogItem[] = [
  ...[144, 192, 240].map((L) => item({ sku: `TB-${L / 12}`, category: 'decking', group: 'TESTBRAND|Line A|Gray', brand: 'TestBrand', collection: 'Line A', color: 'Gray', material: 'composite', widthIn: 5.5, thicknessIn: 1, stockLengthIn: L, cost: L / 12 * 3, spec: { gapIn: 0.25, maxJoistSpacingIn: 16 } })),
  ...[144, 192].map((L) => item({ sku: `TB2-${L / 12}`, category: 'decking', group: 'TESTBRAND2|Line B|Brown', brand: 'TestBrand2', material: 'composite', widthIn: 5.5, stockLengthIn: L, cost: 50, spec: { gapIn: 0.25, maxJoistSpacingIn: 12 } })),
  ...[144, 192].map((L) => item({ sku: `WD-${L / 12}`, category: 'decking', group: 'WOOD|PT|Natural', material: 'wood', widthIn: 5.5, stockLengthIn: L, cost: 12, spec: { gapIn: 0.125, maxJoistSpacingIn: 16 } })),
  ...[144, 192].map((L) => item({ sku: `FA-${L / 12}`, category: 'fascia', group: 'TESTBRAND|Fascia|Gray', brand: 'TestBrand', widthIn: 11.25, heightIn: 11.25, stockLengthIn: L, cost: 40 })),
  item({ sku: 'CLIP-90', category: 'fastener', brand: 'TestBrand', packQty: 90, purchaseUnit: 'box', spec: { perCrossing: 1 }, cost: 30 }),
  item({ sku: 'CLIP-W', category: 'fastener', spec: { perCrossing: 2, compatibleSystems: ['WOOD|PT|Natural'] }, packQty: 350, purchaseUnit: 'box', cost: 40 }),
  ...[96, 120, 144, 192, 240].map((L) => item({ sku: `2x10-${L / 12}`, category: 'joist', profile: '2x10', material: 'wood', stockLengthIn: L, cost: L / 12 * 2 })),
  ...[96, 120].map((L) => item({ sku: `6x6-${L / 12}`, category: 'post', profile: '6x6', stockLengthIn: L, cost: 40 })),
  item({ sku: 'HGR-210', category: 'hanger', profile: '2x10', cost: 2 }),
  item({ sku: 'CONC-80', category: 'concrete', purchaseUnit: 'bag', yieldCuFt: 0.6, cost: 6 }),
  item({ sku: 'RS-6', category: 'railing-section', spec: { railingSystem: 'TestRail', maxSpanIn: 72, colors: ['Black', 'White'] }, purchaseUnit: 'kit', cost: 100 }),
  item({ sku: 'RS-8', category: 'railing-section', spec: { railingSystem: 'TestRail', maxSpanIn: 96, colors: ['Black', 'White'] }, purchaseUnit: 'kit', cost: 120 }),
  item({ sku: 'RP-1', category: 'railing-post', spec: { railingSystem: 'TestRail', colors: ['Black', 'White'] }, cost: 30 }),
  item({ sku: 'RCAP', category: 'railing-accessory', spec: { railingSystem: 'TestRail', per: 'post', perQty: 1 }, cost: 5 }),
  item({ sku: 'GATE-1', category: 'gate', spec: { railingSystem: 'TestRail' }, cost: 300 }),
  item({ sku: 'STR-RAIL', category: 'stair-rail', spec: { railingSystem: 'TestRail', maxSpanIn: 96 }, cost: 150 }),
  item({ sku: 'STRINGER-12', category: 'stringer', stockLengthIn: 144, cost: 25 }),
  item({ sku: 'LAB-DECK', category: 'labor', group: 'deck-sqft', labor: { unit: 'sqft', rate: 10 }, sale: { method: 'margin', pct: 40 } }),
];

export const verifiedTestRules: RuleSet = {
  id: 'TEST-RULES', version: 1, status: 'verified', jurisdiction: 'TEST', codeEdition: 'TEST', source: 'test fixture only', effectiveDate: '2026-01-01', reviewer: 'test',
  joistSpans: [{ speciesGrade: 'SYP #2', size: '2x10', spacingIn: 16, maxSpanIn: 180, maxCantileverIn: 36 }],
  beamSpans: [{ speciesGrade: 'SYP #2', size: '2x10', plies: 2, joistSpanIn: 200, maxPostSpacingIn: 96 }],
  stairs: { maxRiserIn: 7.75, minTreadIn: 10, minWidthIn: 36, maxStringerSpacingIn: 18, guardRequiredAboveIn: 30, handrailRequiredAtRisers: 4 },
};

export const testTax = { configured: true, ratePct: 6, base: 'materials' as const };

/** A complete 16' (x, along house) × 20'?  NOTE: rect w=x-extent, h=y-extent. */
export function rectDoc(wFt: number, hFt: number): EstimateDoc {
  const d = newEstimateDoc();
  d.geometry.shapes = [{ id: 'A', label: 'Main', kind: 'rect', x: 0, y: 0, w: wFt * 12, h: hFt * 12, heightIn: 36 }];
  d.geometry.joistAngleDeg = 90; // joists run along y (away from the house)
  d.geometry.deckingAngleDeg = 0; // boards run along x
  return d;
}

export function completeDoc(): EstimateDoc {
  const d = rectDoc(16, 12);
  // house along the bottom edge (A:0 from (0,0) to (192,0)); others open + railed
  d.geometry.edgeTags = {
    'A:0': { side: 'house', ledger: true },
    'A:1': { side: 'open', rail: true, fascia: true },
    'A:2': { side: 'open', rail: true, fascia: true },
    'A:3': { side: 'open', rail: true, fascia: true },
  };
  d.consult.materials.composite = true;
  d.consult.compositeBrands = ['TestBrand'];
  d.consult.fascia = true;
  d.consult.railing.wanted = true;
  d.alternatives = [{ id: 'alt1', name: 'TestBrand Gray', kind: 'composite', brand: 'TestBrand', deckingGroup: 'TESTBRAND|Line A|Gray', fasciaGroup: 'TESTBRAND|Fascia|Gray', railingSystem: 'TestRail', railingColor: 'Black', status: 'active' }];
  d.structure = {
    attachment: 'attached', ledger: { substrate: 'wood-rim-joist', flashing: 'existing-ok' },
    joist: { size: '2x10', speciesGrade: 'SYP #2', spacingIn: 16, rimPlies: 1 },
    beams: [{ id: 'B1', offsetIn: 132, size: '2x10', plies: 2, postSpacingIn: 96 }],
    postSize: '6x6',
  };
  d.footings = { support: 'new-footings', spec: { shape: 'round', diameterIn: 12, depthIn: 30 }, wastePct: 10, concreteSku: 'CONC-80', bearingAssumptionPsf: 1500 };
  return d;
}
