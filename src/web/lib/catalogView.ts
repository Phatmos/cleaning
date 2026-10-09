import type { CatalogItem } from '../../shared/types';

export interface ProductGroup { group: string; brand?: string; collection?: string; color?: string; texture?: string; profile?: string; material?: string; items: CatalogItem[]; widthIn?: number; lengths: number[]; priced: boolean; demo: boolean; skus: string[] }

export function groupsOf(catalog: CatalogItem[], category: 'decking' | 'fascia', filter?: (i: CatalogItem) => boolean): ProductGroup[] {
  const m = new Map<string, ProductGroup>();
  for (const it of catalog) {
    if (!it.active || it.category !== category || !it.group || (filter && !filter(it))) continue;
    const g = m.get(it.group) ?? { group: it.group, brand: it.brand, collection: it.collection, color: it.color, texture: it.texture, profile: it.profile, material: it.material, items: [], widthIn: it.widthIn, lengths: [], priced: true, demo: false, skus: [] };
    g.items.push(it);
    if (it.stockLengthIn) g.lengths.push(it.stockLengthIn / 12);
    if (it.cost === undefined && it.sale?.method !== 'fixed') g.priced = false;
    if (it.isDemo) g.demo = true;
    g.skus.push(it.sku);
    m.set(it.group, g);
  }
  for (const g of m.values()) g.lengths.sort((a, b) => a - b);
  return [...m.values()].sort((a, b) => (a.brand ?? '').localeCompare(b.brand ?? '') || (a.collection ?? '').localeCompare(b.collection ?? '') || (a.color ?? '').localeCompare(b.color ?? ''));
}

export const isComposite = (i: CatalogItem) => i.material !== 'wood';
export const isWood = (i: CatalogItem) => i.material === 'wood';

export function compositeBrands(catalog: CatalogItem[], configured: string[] = []): string[] {
  const s = new Set(configured);
  for (const i of catalog) if (i.active && i.category === 'decking' && i.brand && isComposite(i)) s.add(i.brand);
  return [...s];
}

export interface RailingSystem { name: string; brand?: string; material?: string; colors: string[]; kits: CatalogItem[]; hasPost: boolean; hasGate: boolean; hasStairRail: boolean; infill: string[] }
export function railingSystems(catalog: CatalogItem[]): RailingSystem[] {
  const m = new Map<string, RailingSystem>();
  for (const i of catalog) {
    const sys = i.spec?.railingSystem;
    if (!i.active || !sys) continue;
    const r = m.get(sys) ?? { name: sys, brand: i.brand, material: i.material, colors: [], kits: [], hasPost: false, hasGate: false, hasStairRail: false, infill: [] };
    if (i.category === 'railing-section') { r.kits.push(i); for (const c of i.spec?.colors ?? []) if (!r.colors.includes(c)) r.colors.push(c); if (i.profile && !r.infill.includes(i.profile)) r.infill.push(i.profile); }
    if (i.category === 'railing-post') r.hasPost = true;
    if (i.category === 'gate') r.hasGate = true;
    if (i.category === 'stair-rail') r.hasStairRail = true;
    m.set(sys, r);
  }
  return [...m.values()];
}

export const groupLabel = (g?: string) => (g ? g.split('|').filter(Boolean).join(' · ') : '—');
