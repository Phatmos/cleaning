/** Leap price-book mapping and labor selection. Rows below are SYNTHETIC (format only, fictitious prices). */
import { describe, expect, it } from 'vitest';
import { detectLeap, mapLeapRow, stockLengthFromSize } from '../src/server/leapImport';
import { validateBatch } from '../src/server/catalogImport';
import { applySpecs, DEFAULT_SETTINGS } from '../src/server/app';
import { calculate, heightTier, stairWidthBand, totals } from '../src/engine';
import type { CatalogItem } from '../src/shared/types';
import { completeDoc, testCatalog, testTax, verifiedTestRules } from './fixtures';

const MAT_H = ['Name', 'Code', 'Description', 'Unit', 'Unit Cost', 'Selling Price', 'Trade', 'Style', 'Size', 'Color', 'Brand', 'Product Type'];
const LAB_H = ['Name', 'Code', 'Trade', 'Description', 'Unit', 'Unit Cost', 'Selling Price'];
const mat = (name: string, code: string, unit: string, cost: number, trade: string, style: string, size: string, color: string, brand: string, type: string) => [name, code, 'desc', unit, cost, cost * 1.1, trade, style, size, color, brand, type];

describe('Leap material mapping', () => {
  it('detects both formats', () => {
    expect(detectLeap(MAT_H)).toBe('leap-material');
    expect(detectLeap(LAB_H)).toBe('leap-labor');
    expect(detectLeap(['sku', 'price'])).toBeNull();
  });
  it('maps boards, fascia, lumber, clips, rail kits and posts from the file text only', () => {
    const m = (row: unknown[]) => mapLeapRow('leap-material', MAT_H, row, 'test');
    const board = m(mat('X Board', 'T-1', 'EA', 40, 'DECKING', 'LineA', '1x6x16 ft - Grooved', 'Gray', 'BrandA', 'Composite Deck Board')).item!;
    expect(board.category).toBe('decking');
    expect(board.stockLengthIn).toBe(192);
    expect(board.group).toBe('BrandA|LineA|Gray');
    expect(board.widthIn).toBeUndefined(); // not in the file → never invented
    expect(board.sale).toEqual({ method: 'fixed', price: 44 });
    const fascia = m(mat('F', 'T-2', 'EA', 70, 'DECKING', 'LineA', '1/2x12x12 ft', 'Gray', 'BrandA', 'Fascia')).item!;
    expect([fascia.category, fascia.heightIn, fascia.stockLengthIn, fascia.group]).toEqual(['fascia', 12, 144, 'BrandA|LineA Fascia|Gray']);
    const joist = m(mat('PT', 'T-3', 'EA', 20, 'CARPENTRY', 'Ground Contact', '2x10x16 ft', 'PT', 'Generic', 'Treated Lumber')).item!;
    expect([joist.category, joist.profile, joist.stockLengthIn]).toEqual(['joist', '2x10', 192]);
    expect(m(mat('PT', 'T-4', 'EA', 20, 'CARPENTRY', 'Ground Contact', '6x6x10 ft', 'PT', 'Generic', 'Treated Lumber')).item!.category).toBe('post');
    const clip = m(mat('Clip', 'T-5', 'BOX', 40, 'CARPENTRY', 'Hidden Fastener', '90 ct', '-', 'BrandA', 'Clip'));
    expect(clip.item!.packQty).toBe(90);
    expect(clip.item!.spec?.perCrossing).toBeUndefined();
    expect(m(mat('Screw', 'T-6', 'BOX', 30, 'CARPENTRY', 'Deck Screw', '#9 x 3 in / 5 lb', '-', 'Generic', 'Screw')).item!.packQty).toBeUndefined(); // 5 lb is not a count
    const kit = m(mat('Kit', 'T-7', 'KIT', 200, 'RAILING', 'BrandA Alu Rail Kit', '8 ft x 36 in', 'Black', 'BrandA', 'Railing Kit'));
    expect(kit.item!.spec).toMatchObject({ railingSystem: 'BrandA Alu', maxSpanIn: 96, colors: ['Black'] });
    expect(kit.derived.join(' ')).toMatch(/verify/);
    expect(m(mat('Kit', 'T-8', 'KIT', 200, 'RAILING', 'BrandA Alu Stair Rail Kit', '6 ft x 36 in', 'Black', 'BrandA', 'Railing Kit')).item!.category).toBe('stair-rail');
  });
  it('validation reports file-level gaps once and rejects bad rows', () => {
    const rows = [mat('A', 'D-1', 'EA', 1, 'DECKING', 'L', '1x6x12 ft', 'C', 'B', 'Composite Deck Board'), mat('A', 'D-1', 'EA', 1, 'DECKING', 'L', '1x6x12 ft', 'C', 'B', 'Composite Deck Board'), ['', 'D-2', 'd', 'ZZ', 'x', 1]].map((r) => r.map(String));
    const rep = validateBatch(MAT_H, rows, { __format: 'leap-material' }, new Set(), 'f');
    expect(rep.counts).toMatchObject({ create: 1, skip: 2 });
    expect(rep.missingFields).toContain('As of / effective date');
  });
  it('labor rows keep the book selling price', () => {
    const r = mapLeapRow('leap-labor', LAB_H, ['Install Thing - Up to 6 ft', 'L-1', 'DECKING', 'd', 'SQ FT', 3, 4.5], 'labor');
    expect(r.item).toMatchObject({ category: 'labor', labor: { unit: 'sqft', rate: 3 }, sale: { method: 'fixed', price: 4.5 } });
  });
  it('size parsing', () => {
    expect(stockLengthFromSize('2x4x8 ft')).toBe(96);
    expect(stockLengthFromSize('80 lb')).toBeUndefined();
  });
});

describe('product spec rules', () => {
  it('fill only missing values and record their source', () => {
    const item: CatalogItem = { id: 'x', sku: 'S', description: 'd', category: 'decking', brand: 'B', collection: 'L', purchaseUnit: 'each', active: true, spec: { gapIn: 0.25 } };
    const out = applySpecs(item, [{ id: 'r1', match: { category: 'decking', brand: 'B' }, set: { widthIn: 5.5, gapIn: 0.1, maxJoistSpacingIn: 16 }, source: 'install guide p.4' }]);
    expect(out.widthIn).toBe(5.5);
    expect(out.spec?.gapIn).toBe(0.25);
    expect(out.specSource).toMatch(/install guide/);
    expect(applySpecs(item, [{ id: 'r2', match: { brand: 'Other' }, set: { widthIn: 9 }, source: 's' }]).widthIn).toBeUndefined();
  });
});

describe('labor selection from the labor book', () => {
  const map = DEFAULT_SETTINGS.laborMap;
  const lab = (name: string, unit: string, rate: number): CatalogItem => ({ id: `lab-${name}`, sku: `L-${name.length}-${rate}`, description: name, category: 'labor', purchaseUnit: 'each', labor: { unit, rate }, sale: { method: 'fixed', price: rate * 1.5 }, active: true });
  const labor = [
    lab('Structural Deck Frame - Up to 6 ft - 2x10 @ 16 in OC', 'sqft', 4),
    lab('Structural Deck Frame - 7-18 ft - 2x10 @ 16 in OC', 'sqft', 4.5),
    lab('Install Composite/PVC Decking + Joist Tape - Up to 6 ft', 'sqft', 2.75),
    lab('Install Composite/PVC Fascia - Up to 6 ft', 'lf', 1.75),
    lab('Install Concrete Pier', 'each', 75),
    lab('Install Aluminum/Steel Railing', 'lf', 7.65),
  ];
  const catalog = [...testCatalog.filter((c) => c.category !== 'labor'), ...labor];
  it('tiers and bands', () => {
    expect(heightTier(map, 36)).toBe('Up to 6 ft');
    expect(heightTier(map, 72)).toBe('Up to 6 ft');
    expect(heightTier(map, 100)).toBe('7-18 ft');
    expect(heightTier(map, 300)).toBe('19 ft Plus');
    expect(stairWidthBand(map, 48)).toBe('4-5 ft Wide');
    expect(stairWidthBand(map, 200)).toBeUndefined();
  });
  it('picks labor by height tier, joist size and spacing; reports unmapped railing', () => {
    const d = completeDoc();
    const r = calculate(d, { catalog, catalogVersion: 't', rules: verifiedTestRules, tax: testTax, laborMap: map });
    const lines = r.alternatives[0].lines.filter((l) => l.kind === 'labor');
    expect(lines.find((l) => l.key === 'labor:framing')?.description).toBe('Structural Deck Frame - Up to 6 ft - 2x10 @ 16 in OC');
    expect(lines.find((l) => l.key === 'labor:framing')?.calcQty).toBe(192);
    expect(lines.find((l) => l.key === 'labor:pier')?.calcQty).toBe(3);
    expect(r.alternatives[0].issues.some((i) => i.id === 'labor-rail-alt1')).toBe(true); // TestRail has no mapped labor
    (d.geometry.shapes[0] as any).heightIn = 100;
    const r2 = calculate(d, { catalog, catalogVersion: 't', rules: verifiedTestRules, tax: testTax, laborMap: map });
    expect(r2.alternatives[0].lines.find((l) => l.key === 'labor:framing')?.description).toMatch(/7-18 ft/);
    expect(r2.alternatives[0].issues.some((i) => i.id === 'labor-missing-decking')).toBe(true); // 7-18 ft decking item absent → reported, not substituted
  });
});

describe('pricing policy', () => {
  it('project markup is applied on sell; commission is internal and reduces margin', () => {
    const line = { key: 'm', kind: 'material' as const, group: 'Other' as const, description: '', unit: 'ea', calcQty: 1, purchaseQty: 1, effectiveQty: 1, formula: '', inputs: {}, status: 'ok' as const, extCost: 50, extSell: 100 };
    const t = totals([line], { tax: { configured: true, ratePct: 0, base: 'none' }, policy: { projectMarkupPct: 25, commissionPct: 10, confirmed: true } }).totals;
    expect(t.projectMarkup).toBe(25);
    expect(t.total).toBe(125);
    expect(t.commission).toBe(12.5);
    expect(t.marginPct).toBeCloseTo(((125 - 50 - 12.5) / 125) * 100, 9);
  });
});
