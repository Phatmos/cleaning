/**
 * Pricing. Material cost, labor cost, markup/margin, customer price, tax,
 * allowances and discount are kept as separate numbers.
 *
 *   markup  : sell = cost × (1 + markup%)          (markup is on COST)
 *   margin  : sell = cost ÷ (1 − margin%)          (margin is on SELL price)
 *   fixed   : sell = configured price per unit
 *
 * A line whose item has no cost and no fixed price is NEEDS PRICING. It is never
 * treated as $0; totals report it and sending is blocked.
 */
import type { BomLine, CatalogItem, Issue, PricingPolicy } from '../shared/types';

export interface TaxConfig { configured: boolean; ratePct?: number; base?: 'materials' | 'all' | 'none'; verifiedBy?: string; note?: string }

export function unitSell(item: CatalogItem): number | null {
  const s = item.sale;
  if (s?.method === 'fixed') return s.price ?? null;
  if (item.cost === undefined || item.cost === null) return null;
  if (!s || s.pct === undefined) return null;
  if (s.method === 'markup') return item.cost * (1 + s.pct / 100);
  if (s.method === 'margin') {
    if (s.pct >= 100) return null;
    return item.cost / (1 - s.pct / 100);
  }
  return null;
}

export interface PricedLine extends BomLine {
  unitCost?: number;
  unitSell?: number;
  extCost?: number;
  extSell?: number;
  kind: 'material' | 'labor' | 'allowance';
  priceOverride?: { value: number; reason: string; by: string };
}

export interface Totals {
  materialCost: number;
  laborCost: number;
  materialSell: number;
  laborSell: number;
  allowances: number;
  /** Project markup (overhead & profit) from the pricing policy, on material + labor selling prices. */
  projectMarkup: number;
  /** Internal only. */
  commission: number;
  subtotal: number;
  discount: number;
  taxable: number;
  tax: number | null;
  total: number | null;
  needsPricing: string[];
  marginPct: number | null;
  markupPct: number | null;
}

export function priceLines(lines: PricedLine[], catalog: Map<string, CatalogItem>): PricedLine[] {
  return lines.map((l) => {
    if (l.kind === 'allowance') return l;
    const item = l.catalogId ? catalog.get(l.catalogId) : undefined;
    if (!item) return { ...l, status: l.status === 'ok' ? 'needs-product' : l.status };
    if (l.kind === 'labor') {
      const rate = item.labor?.rate;
      if (rate === undefined) return { ...l, status: 'needs-pricing' };
      const cost = rate;
      const sell = item.sale?.method === 'fixed' ? item.sale.price ?? null : item.sale?.pct !== undefined ? (item.sale.method === 'margin' ? cost / (1 - item.sale.pct / 100) : cost * (1 + item.sale.pct / 100)) : null;
      if (sell === null) return { ...l, unitCost: cost, extCost: cost * l.effectiveQty, status: 'needs-pricing' };
      return { ...l, unitCost: cost, unitSell: sell, extCost: cost * l.effectiveQty, extSell: sell * l.effectiveQty };
    }
    const us = l.priceOverride ? l.priceOverride.value : unitSell(item);
    if (us === null) return { ...l, unitCost: item.cost, status: 'needs-pricing' };
    return { ...l, unitCost: item.cost, unitSell: us, extCost: item.cost !== undefined ? item.cost * l.effectiveQty : undefined, extSell: us * l.effectiveQty };
  });
}

export function totals(lines: PricedLine[], opts: { discountPct?: number; discountAmount?: number; tax: TaxConfig; policy?: PricingPolicy }): { totals: Totals; issues: Issue[] } {
  const issues: Issue[] = [];
  const t: Totals = { materialCost: 0, laborCost: 0, materialSell: 0, laborSell: 0, allowances: 0, projectMarkup: 0, commission: 0, subtotal: 0, discount: 0, taxable: 0, tax: null, total: null, needsPricing: [], marginPct: null, markupPct: null };
  for (const l of lines) {
    if (l.effectiveQty === 0) continue;
    if (l.kind === 'allowance') { t.allowances += l.extSell ?? 0; continue; }
    if (l.status === 'needs-pricing' || l.status === 'needs-product' || l.extSell === undefined) { t.needsPricing.push(l.key); continue; }
    if (l.kind === 'labor') { t.laborCost += l.extCost ?? 0; t.laborSell += l.extSell; }
    else { t.materialCost += l.extCost ?? 0; t.materialSell += l.extSell; }
  }
  const markupPct = opts.policy?.projectMarkupPct ?? 0;
  t.projectMarkup = ((t.materialSell + t.laborSell) * markupPct) / 100;
  const sell = t.materialSell + t.laborSell + t.projectMarkup;
  t.subtotal = sell + t.allowances;
  t.discount = (opts.discountAmount ?? 0) + (sell * (opts.discountPct ?? 0)) / 100;
  if (!opts.tax.configured) {
    issues.push({ id: 'tax-unconfigured', severity: 'blocker', area: 'pricing', message: 'Sales tax treatment is not configured/verified', hint: 'Admin › Settings › Tax: set the verified Kentucky treatment for this contract type.' });
  } else {
    const base = opts.tax.base ?? 'none';
    const discShare = sell > 0 ? t.discount * ((t.materialSell * (1 + markupPct / 100)) / sell) : 0;
    t.taxable = base === 'materials' ? t.materialSell * (1 + markupPct / 100) - discShare : base === 'all' ? t.subtotal - t.discount : 0;
    t.tax = (Math.max(0, t.taxable) * (opts.tax.ratePct ?? 0)) / 100;
  }
  if (t.needsPricing.length) issues.push({ id: 'needs-pricing', severity: 'blocker', area: 'pricing', message: `${t.needsPricing.length} line(s) need pricing — total is incomplete`, hint: 'Missing prices are never counted as $0.' });
  t.total = t.needsPricing.length || t.tax === null ? null : t.subtotal - t.discount + t.tax;
  const cost = t.materialCost + t.laborCost;
  const net = sell - t.discount;
  t.commission = (net * (opts.policy?.commissionPct ?? 0)) / 100;
  // Margin/markup after commission (commission is a cost to the company).
  t.marginPct = net > 0 ? ((net - cost - t.commission) / net) * 100 : null;
  t.markupPct = cost > 0 ? ((net - cost - t.commission) / cost) * 100 : null;
  return { totals: t, issues };
}
