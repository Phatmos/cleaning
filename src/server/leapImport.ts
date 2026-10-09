/**
 * Yellowstone "Leap" price-book formats.
 *
 *  Material: Name, Code, Description, Unit, Unit Cost, Selling Price, Trade, Style,
 *            Size, Color, Brand, Product Type  (+ Price Basis, Price Confidence,
 *            As of, Active on the "Master Catalog" sheet)
 *  Labor:    Name, Code, Trade, Description, Unit, Unit Cost, Selling Price
 *
 * Only facts present in the file are mapped. Values the file does not state —
 * actual board width, board gap, max joist spacing, clips per joist crossing,
 * concrete yield — are left empty and reported; an admin enters them once per
 * product line in Admin › Product specs.
 *
 * A few fields are DERIVED from the file's own text (stock length from "1x6x16 ft",
 * fascia height from "1/2x12x12 ft", box count from "90 ct", rail-kit length from
 * "6 ft x 36 in"). Each derived field is listed in the item's `derived` notes.
 */
import type { CatalogItem, Category } from '../shared/types';

export type LeapFormat = 'leap-material' | 'leap-labor';
const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

export function detectLeap(headers: string[]): LeapFormat | null {
  const h = headers.map(norm);
  const has = (...k: string[]) => k.every((x) => h.includes(x));
  if (has('name', 'code', 'unit', 'unit cost', 'selling price', 'trade', 'style', 'size', 'color', 'brand', 'product type')) return 'leap-material';
  if (has('name', 'code', 'trade', 'description', 'unit', 'unit cost', 'selling price')) return 'leap-labor';
  return null;
}

const UNIT: Record<string, CatalogItem['purchaseUnit']> = { ea: 'each', each: 'each', box: 'box', kit: 'kit', roll: 'roll', pct: 'pct', bag: 'bag', lf: 'lf', sqft: 'sqft' };
const LABOR_UNIT: Record<string, string> = { 'sq ft': 'sqft', 'ln ft': 'lf', ea: 'each', step: 'step', sq: 'square', post: 'post', pair: 'pair' };

/** "1x6x16 ft" → 192 ; "2x10x12 ft" → 144 ; "16 ft" → 192 ; "10 ft" → 120 */
export function stockLengthFromSize(size: string): number | undefined {
  const m = size.match(/(\d+(?:\.\d+)?)\s*ft\b/i);
  return m ? parseFloat(m[1]) * 12 : undefined;
}
/** "2x10x12 ft" → "2x10" */
export function nominalFromSize(size: string): string | undefined {
  const m = size.match(/^(\d+x\d+)x\d/);
  return m ? m[1] : undefined;
}

export interface LeapRowResult { item?: CatalogItem; errors: string[]; warnings: string[]; derived: string[] }

export function mapLeapRow(format: LeapFormat, headers: string[], row: unknown[], sourceName: string): LeapRowResult {
  const idx = (k: string) => headers.findIndex((h) => norm(h) === k);
  const get = (k: string) => { const i = idx(k); return i < 0 ? '' : String(row[i] ?? '').trim(); };
  const num = (k: string) => { const v = get(k).replace(/[$,]/g, ''); if (!v) return undefined; const n = Number(v); return Number.isFinite(n) ? n : NaN; };
  const errors: string[] = [];
  const warnings: string[] = [];
  const derived: string[] = [];
  const sku = get('code');
  const name = get('name');
  if (!sku) errors.push('Code (SKU) missing');
  if (!name) errors.push('Name missing');
  const cost = num('unit cost');
  const sell = num('selling price');
  if (cost === undefined || Number.isNaN(cost)) errors.push('Unit Cost missing or not a number');
  if (sell === undefined || Number.isNaN(sell)) errors.push('Selling Price missing or not a number');
  if (cost !== undefined && sell !== undefined && sell < cost) warnings.push('Selling Price is below Unit Cost');
  const active = !get('active') || norm(get('active')) === 'yes';
  const asOf = get('as of') || undefined;
  if (!asOf) warnings.push('No "As of" date in this sheet');

  if (format === 'leap-labor') {
    const unitRaw = norm(get('unit'));
    const unit = LABOR_UNIT[unitRaw] ?? unitRaw;
    if (!LABOR_UNIT[unitRaw]) warnings.push(`Unrecognized labor unit "${get('unit')}"`);
    const item: CatalogItem = {
      id: '', sku, description: name, category: 'labor', trade: get('trade'), notes: get('description'),
      purchaseUnit: 'each', labor: { unit: unit as any, rate: cost ?? 0 }, sale: { method: 'fixed', price: sell },
      effectiveDate: asOf, source: sourceName, active,
    };
    return { item: errors.length ? undefined : item, errors, warnings, derived };
  }

  const type = get('product type');
  const brand = get('brand') || undefined;
  const style = get('style') || undefined;
  const size = get('size');
  const color = get('color') || undefined;
  const trade = get('trade');
  const unitRaw = norm(get('unit'));
  const purchaseUnit = UNIT[unitRaw];
  if (!purchaseUnit) errors.push(`Unrecognized unit "${get('unit')}"`);
  const base: CatalogItem = {
    id: '', sku, description: name, category: 'other', brand, collection: style, color, trade, notes: get('description'),
    purchaseUnit: purchaseUnit ?? 'each', cost, sale: { method: 'fixed', price: sell }, effectiveDate: asOf,
    source: `${sourceName}${get('price basis') ? ` — ${get('price basis')}` : ''}`, priceConfidence: get('price confidence') || undefined, active,
  };
  const len = stockLengthFromSize(size);
  const lenNote = () => { if (len) derived.push(`stock length ${len / 12} ft from size "${size}"`); };
  const set = (p: Partial<CatalogItem>) => Object.assign(base, p);
  const cat = (c: Category) => (base.category = c);

  switch (type) {
    case 'Composite Deck Board':
      cat('decking'); lenNote();
      set({ material: 'composite', group: `${brand}|${style}|${color}`, stockLengthIn: len, profile: /grooved/i.test(size) ? 'Grooved' : /square/i.test(size) ? 'Square edge' : undefined });
      break;
    case 'Fascia':
    case 'Riser': {
      cat('fascia'); lenNote();
      const h = size.match(/^[\d/]+x(\d+(?:\.\d+)?)x/);
      if (h) { set({ heightIn: parseFloat(h[1]) }); derived.push(`board height ${h[1]}" from size "${size}" (nominal; verify actual)`); }
      set({ material: 'composite', group: `${brand}|${style} ${type}|${color}`, stockLengthIn: len, profile: type });
      break;
    }
    case 'Treated Lumber':
    case 'Cedar Lumber': {
      const nom = nominalFromSize(size);
      lenNote();
      set({ material: 'wood', profile: nom, stockLengthIn: len });
      if (nom === '4x4' || nom === '6x6') cat('post');
      else if (type === 'Cedar Lumber' || nom === '2x6') { cat('decking'); set({ group: `${brand}|${type === 'Cedar Lumber' ? 'Cedar' : 'Pressure-treated'} ${nom}|${color}` }); }
      else if (nom === '2x4') cat('blocking');
      else cat('joist');
      break;
    }
    case 'Concrete': cat('concrete'); set({ purchaseUnit: 'bag' }); break;
    case 'Form Tube': cat('footing-hardware'); break;
    case 'Post Base': cat('footing-hardware'); set({ profile: size, spec: { per: 'post', perQty: 1 } }); derived.push('quantity rule: 1 per structural post (editable)'); break;
    case 'Post Cap': cat('connector'); set({ profile: size, spec: { per: 'post', perQty: 1 } }); derived.push('quantity rule: 1 per structural post (editable)'); break;
    case 'Joist Hanger': cat('hanger'); set({ profile: size }); break;
    case 'Beam Hanger': case 'Tie': case 'Bolt': case 'Anchor Bolt': case 'Connector Screw': cat('connector'); break;
    case 'Ledger Screw': case 'Structural Screw': case 'Screw': case 'Plug/Screw': case 'Clip': {
      cat('fastener');
      const ct = size.match(/(\d+)\s*(?:ct)?$/i) && size.match(/\/\s*(\d+)\b|(\d+)\s*ct/i);
      const n = ct ? Number(ct[1] ?? ct[2]) : undefined;
      if (n) { set({ packQty: n }); derived.push(`pack quantity ${n} from size "${size}"`); }
      if (type === 'Clip') set({ material: 'composite' });
      if (type === 'Screw') set({ material: 'wood' });
      break;
    }
    case 'Joist Tape': case 'Beam Tape': case 'Flashing Tape': cat('other'); break;
    case 'Ledger Flashing': cat('flashing'); lenNote(); set({ stockLengthIn: len }); break;
    case 'Railing Kit': {
      const stair = /stair/i.test(style ?? '');
      cat(stair ? 'stair-rail' : 'railing-section');
      const system = (style ?? '').replace(/\s*Stair Rail Kit$/i, '').replace(/\s*Rail Kit$/i, '').replace(/\s*Rail Express$/i, ' Express').trim();
      const kitFt = size.match(/(\d+(?:\.\d+)?)\s*ft/i);
      const hIn = size.match(/x\s*(\d+)\s*in/i);
      set({ spec: { railingSystem: system, colors: color ? [color] : undefined, maxSpanIn: kitFt ? parseFloat(kitFt[1]) * 12 : undefined }, heightIn: hIn ? Number(hIn[1]) : undefined, material: /aluminum|alx/i.test(style ?? '') ? 'aluminum' : 'composite' });
      if (kitFt) derived.push(`max post spacing ${kitFt[1]} ft taken from kit length "${size}" — verify against manufacturer instructions`);
      break;
    }
    case 'Railing Post': {
      cat('railing-post');
      const hIn = size.match(/(\d+)\s*in/i);
      set({ heightIn: hIn ? Number(hIn[1]) : undefined, material: 'aluminum', spec: { colors: color ? [color] : undefined, compatibleBrand: brand } });
      derived.push(`compatible with ${brand} railing systems (inferred from brand — verify)`);
      break;
    }
    case 'Lighting': {
      cat('lighting');
      if (/post cap/i.test(name)) set({ spec: { per: 'post', perQty: 1 } });
      else if (/stair/i.test(name)) set({ spec: { per: 'riser', perQty: 1 } });
      else if (/transformer/i.test(name)) set({ spec: { per: 'job', perQty: 1 } });
      break;
    }
    case 'Lattice': cat('skirting'); break;
    case 'Allowance': cat('other'); set({ allowance: true }); break;
    default:
      cat('other');
      if (trade !== 'FENCING' && trade !== 'GENERAL') warnings.push(`Product type "${type}" is imported for manual use only (no automatic quantity rule)`);
  }
  if (base.category === 'decking' && !base.widthIn) warnings.push('Actual board width, gap and max joist spacing are not in the file — add them in Admin › Product specs');
  if (base.category === 'concrete') warnings.push('Concrete yield per bag is not in the file — add it in Admin › Product specs');
  if (base.category === 'fastener' && /clip|screw/i.test(type) && type !== 'Ledger Screw' && type !== 'Structural Screw') warnings.push('Fasteners per joist crossing not in the file — add it in Admin › Product specs');
  return { item: errors.length ? undefined : base, errors, warnings, derived };
}
