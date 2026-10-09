/**
 * Price-list import: parse → preview → column mapping → validation →
 * duplicate handling → admin approval. Nothing reaches the live catalog until an
 * admin approves the batch; missing fields are reported, never invented.
 */
import Papa from 'papaparse';
import { createRequire } from 'node:module';
import type { CatalogItem, Category } from '../shared/types';
import { detectLeap, mapLeapRow, type LeapFormat } from './leapImport';

export const CATEGORIES: Category[] = [
  'decking', 'fascia', 'joist', 'beam', 'post', 'ledger', 'rim', 'blocking', 'hanger', 'connector', 'fastener', 'flashing',
  'railing-section', 'railing-post', 'railing-accessory', 'stair-rail', 'gate', 'stringer', 'concrete', 'footing-hardware',
  'lighting', 'skirting', 'labor', 'demolition', 'other',
];

export interface TargetField { key: string; label: string; required?: boolean; type: 'string' | 'number' | 'list'; hint?: string }
export const TARGET_FIELDS: TargetField[] = [
  { key: 'sku', label: 'SKU', required: true, type: 'string' },
  { key: 'description', label: 'Description', required: true, type: 'string' },
  { key: 'category', label: 'Category', required: true, type: 'string', hint: CATEGORIES.join(', ') },
  { key: 'brand', label: 'Brand', type: 'string' },
  { key: 'collection', label: 'Collection', type: 'string' },
  { key: 'color', label: 'Color', type: 'string' },
  { key: 'texture', label: 'Texture', type: 'string' },
  { key: 'profile', label: 'Profile / nominal size', type: 'string', hint: 'e.g. 2x10, 6x6, grooved' },
  { key: 'material', label: 'Material', type: 'string' },
  { key: 'group', label: 'Product group', type: 'string', hint: 'Same board in different lengths shares a group; derived from brand|collection|color if blank' },
  { key: 'thicknessIn', label: 'Actual thickness (in)', type: 'number' },
  { key: 'widthIn', label: 'Actual width (in)', type: 'number' },
  { key: 'heightIn', label: 'Actual height (in)', type: 'number' },
  { key: 'stockLengthFt', label: 'Stock length (ft)', type: 'number' },
  { key: 'stockLengthIn', label: 'Stock length (in)', type: 'number' },
  { key: 'purchaseUnit', label: 'Purchase unit', type: 'string', hint: 'each, lf, sqft, box, bag, pack, kit' },
  { key: 'packQty', label: 'Pack quantity', type: 'number' },
  { key: 'yieldCuFt', label: 'Yield per bag (cu ft)', type: 'number' },
  { key: 'cost', label: 'Cost per purchase unit', type: 'number' },
  { key: 'saleMethod', label: 'Sale-price rule', type: 'string', hint: 'markup, margin or fixed' },
  { key: 'salePct', label: 'Markup / margin %', type: 'number' },
  { key: 'salePrice', label: 'Fixed sale price', type: 'number' },
  { key: 'laborUnit', label: 'Labor unit', type: 'string' },
  { key: 'laborRate', label: 'Labor rate (cost)', type: 'number' },
  { key: 'gapIn', label: 'Board gap (in)', type: 'number' },
  { key: 'maxJoistSpacingIn', label: 'Max joist spacing (in)', type: 'number' },
  { key: 'perCrossing', label: 'Fasteners per joist crossing', type: 'number' },
  { key: 'maxSpanIn', label: 'Railing max span (in)', type: 'number' },
  { key: 'railingSystem', label: 'Railing system', type: 'string' },
  { key: 'compatibleSystems', label: 'Compatible systems', type: 'list' },
  { key: 'colors', label: 'Available colors', type: 'list' },
  { key: 'per', label: 'Accessory per', type: 'string', hint: 'post, section, gate, stair-side, riser' },
  { key: 'perQty', label: 'Qty per', type: 'number' },
  { key: 'effectiveDate', label: 'Effective date', type: 'string' },
  { key: 'source', label: 'Source', type: 'string' },
];

/** Sheets preferred when a workbook has several (Leap books carry metadata on "Master Catalog"). */
const PREFERRED_SHEETS = ['master catalog', 'leap import', 'materials'];
const pickSheet = (names: string[]) => PREFERRED_SHEETS.map((p) => names.find((n) => n.trim().toLowerCase() === p)).find(Boolean) ?? names[0];

export async function parseUpload(filename: string, buf: Buffer): Promise<{ headers: string[]; rows: string[][]; sheet?: string }> {
  const lower = filename.toLowerCase();
  const tidy = (all: unknown[][]) => {
    const width = Math.max(0, ...all.map((r) => r.length));
    const norm = all.map((r) => Array.from({ length: width }, (_, i) => (r[i] === null || r[i] === undefined ? '' : String(r[i])).trim()));
    return { headers: norm[0] ?? [], rows: norm.slice(1).filter((r) => r.some((c) => c)) };
  };
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    // SheetJS reads both .xlsx and legacy Excel 97-2003 (.xls). Admin-only uploads.
    const XLSX = createRequire(import.meta.url)('xlsx') as typeof import('xlsx');
    let wb;
    try { wb = XLSX.read(buf, { type: 'buffer', cellDates: true }); } catch { throw new Error('Could not read this spreadsheet — re-save it from Excel and try again'); }
    const name = pickSheet(wb.SheetNames);
    if (!name) throw new Error('Workbook has no sheets');
    const all = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '' })
      .map((r) => r.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v)));
    return { ...tidy(all), sheet: name };
  }
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) {
    const p = Papa.parse<string[]>(buf.toString('utf8'), { skipEmptyLines: true });
    if (p.errors.length) throw new Error(`CSV parse error: ${p.errors[0].message} (row ${p.errors[0].row})`);
    return tidy(p.data);
  }
  throw new Error('Unsupported file type — upload .csv, .xlsx or .xls');
}

/** Suggest a mapping by fuzzy header match. */
export function suggestMapping(headers: string[]): Record<string, string> {
  const leap = detectLeap(headers);
  if (leap) return { __format: leap };
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const m: Record<string, string> = {};
  for (const f of TARGET_FIELDS) {
    const cands = [f.key, f.label, ...(f.key === 'sku' ? ['item', 'itemnumber', 'partnumber', 'productcode', 'code'] : []), ...(f.key === 'cost' ? ['unitcost', 'price', 'netprice'] : []), ...(f.key === 'stockLengthFt' ? ['length', 'lengthft'] : [])].map(norm);
    const h = headers.find((x) => cands.includes(norm(x)));
    if (h) m[f.key] = h;
  }
  return m;
}

export interface RowResult { row: number; sku?: string; item?: CatalogItem; errors: string[]; warnings: string[]; derived?: string[]; action: 'create' | 'update' | 'skip' }
export interface ImportReport { rows: RowResult[]; counts: { create: number; update: number; skip: number; errors: number; warnings: number }; missingFields: string[] }

export function validateBatch(headers: string[], rows: string[][], mapping: Record<string, string>, existingSkus: Set<string>, sourceName: string): ImportReport {
  if (mapping.__format === 'leap-material' || mapping.__format === 'leap-labor') return validateLeap(mapping.__format, headers, rows, existingSkus, sourceName);
  const idx = (k: string) => (mapping[k] ? headers.indexOf(mapping[k]) : -1);
  const missingFields = TARGET_FIELDS.filter((f) => idx(f.key) < 0).map((f) => f.label);
  const seen = new Map<string, number>();
  const out: RowResult[] = rows.map((r, i) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const get = (k: string) => (idx(k) >= 0 ? (r[idx(k)] ?? '').trim() : '');
    const num = (k: string) => {
      const v = get(k).replace(/[$,]/g, '');
      if (!v) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        errors.push(`${k}: "${get(k)}" is not a number`);
        return undefined;
      }
      return n;
    };
    const list = (k: string) => (get(k) ? get(k).split(/[;|]/).map((s) => s.trim()).filter(Boolean) : undefined);
    const sku = get('sku');
    if (!sku) errors.push('SKU missing');
    const category = get('category').toLowerCase() as Category;
    if (!category) errors.push('Category missing');
    else if (!CATEGORIES.includes(category)) errors.push(`Unknown category "${get('category')}"`);
    const description = get('description');
    if (!description) errors.push('Description missing');
    if (sku) {
      if (seen.has(sku)) errors.push(`Duplicate SKU in file (also row ${seen.get(sku)! + 2})`);
      else seen.set(sku, i);
    }
    const stockFt = num('stockLengthFt');
    const stockIn = num('stockLengthIn') ?? (stockFt !== undefined ? stockFt * 12 : undefined);
    const cost = num('cost');
    const saleMethod = get('saleMethod').toLowerCase();
    const salePct = num('salePct');
    const salePrice = num('salePrice');
    let sale: CatalogItem['sale'];
    if (saleMethod) {
      if (!['markup', 'margin', 'fixed'].includes(saleMethod)) errors.push(`Sale rule "${saleMethod}" must be markup, margin or fixed`);
      else if (saleMethod === 'fixed') sale = { method: 'fixed', price: salePrice };
      else sale = { method: saleMethod as 'markup' | 'margin', pct: salePct };
      if (saleMethod === 'margin' && salePct !== undefined && salePct >= 100) errors.push('Margin must be below 100%');
    }
    const laborRate = num('laborRate');
    const brand = get('brand') || undefined;
    const collection = get('collection') || undefined;
    const color = get('color') || undefined;
    const item: CatalogItem = {
      id: '', sku, description, category, brand, collection, color,
      texture: get('texture') || undefined, profile: get('profile') || undefined, material: (get('material').toLowerCase() || undefined) as CatalogItem['material'],
      group: get('group') || (category === 'decking' || category === 'fascia' ? [brand, collection, color].filter(Boolean).join('|') || undefined : undefined),
      thicknessIn: num('thicknessIn'), widthIn: num('widthIn'), heightIn: num('heightIn'), stockLengthIn: stockIn,
      purchaseUnit: ((get('purchaseUnit').toLowerCase() || 'each') as CatalogItem['purchaseUnit']), packQty: num('packQty'), yieldCuFt: num('yieldCuFt'),
      cost, sale, labor: laborRate !== undefined ? { unit: (get('laborUnit') || 'each') as any, rate: laborRate } : undefined,
      spec: clean({ gapIn: num('gapIn'), maxJoistSpacingIn: num('maxJoistSpacingIn'), perCrossing: num('perCrossing'), maxSpanIn: num('maxSpanIn'), railingSystem: get('railingSystem') || undefined, compatibleSystems: list('compatibleSystems'), colors: list('colors'), per: (get('per') || undefined) as any, perQty: num('perQty') }),
      effectiveDate: get('effectiveDate') || undefined, source: get('source') || sourceName, active: true,
    };
    if (cost === undefined && category !== 'labor' && sale?.method !== 'fixed') warnings.push('No cost — item will show "needs pricing"');
    if (!sale && category !== 'labor') warnings.push('No sale-price rule — item will show "needs pricing"');
    if (['decking', 'fascia', 'joist', 'beam', 'post', 'stringer'].includes(category) && !stockIn) warnings.push('No stock length — cannot be used for cut allocation');
    if (category === 'decking' && !item.widthIn) warnings.push('No actual board width — rows cannot be calculated');
    if (category === 'decking' && item.spec?.gapIn === undefined) warnings.push('No board gap in spec');
    if (category === 'concrete' && !item.yieldCuFt) warnings.push('No documented yield per bag');
    if (category === 'railing-section' && !item.spec?.maxSpanIn) warnings.push('No max span — railing sections cannot be allocated');
    if (category === 'labor' && laborRate === undefined) warnings.push('Labor item without a rate');
    if (!item.effectiveDate) warnings.push('No effective date');
    const action: RowResult['action'] = errors.length ? 'skip' : existingSkus.has(sku) ? 'update' : 'create';
    return { row: i + 2, sku: sku || undefined, item: errors.length ? undefined : item, errors, warnings, action };
  });
  const counts = { create: 0, update: 0, skip: 0, errors: 0, warnings: 0 };
  for (const r of out) {
    counts[r.action]++;
    counts.errors += r.errors.length;
    counts.warnings += r.warnings.length;
  }
  return { rows: out, counts, missingFields };
}

function clean<T extends object>(o: T): T | undefined {
  const e = Object.entries(o).filter(([, v]) => v !== undefined);
  return e.length ? (Object.fromEntries(e) as T) : undefined;
}

export const templateCsv = () => TARGET_FIELDS.map((f) => f.key).join(',') + '\n';

function validateLeap(format: LeapFormat, headers: string[], rows: string[][], existingSkus: Set<string>, sourceName: string): ImportReport {
  const seen = new Map<string, number>();
  const out: RowResult[] = rows.map((r, i) => {
    const m = mapLeapRow(format, headers, r, sourceName);
    const sku = m.item?.sku ?? r[headers.findIndex((h) => h.trim().toLowerCase() === 'code')];
    if (sku && seen.has(sku)) m.errors.push(`Duplicate Code in file (also row ${seen.get(sku)! + 2})`);
    else if (sku) seen.set(sku, i);
    const action: RowResult['action'] = m.errors.length ? 'skip' : existingSkus.has(sku) ? 'update' : 'create';
    return { row: i + 2, sku, item: m.errors.length ? undefined : m.item, errors: m.errors, warnings: m.warnings, derived: m.derived, action };
  });
  // File-level facts are reported once, not on every row.
  const missingFields: string[] = [];
  const noDate = 'No "As of" date in this sheet';
  if (out.some((r) => r.warnings.includes(noDate))) { missingFields.push('As of / effective date'); for (const r of out) r.warnings = r.warnings.filter((w) => w !== noDate); }
  const counts = { create: 0, update: 0, skip: 0, errors: 0, warnings: 0 };
  for (const r of out) { counts[r.action]++; counts.errors += r.errors.length; counts.warnings += r.warnings.length; }
  return { rows: out, counts, missingFields };
}
