import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CatalogItem, RuleSet } from '../../shared/types';
import { api, cached } from './api';
import type { CalcContext } from '../../engine';

export interface Asset { id: string; sku?: string; brand?: string; collection?: string; color?: string; style?: string; kind?: string; source_url?: string; permission_status: string; attribution?: string; retrieved_at?: string }
export interface RefData {
  catalog: CatalogItem[];
  catalogVersion: string;
  rules: RuleSet | null;
  settings: any;
  assets: Asset[];
  packages: any[];
  ctx: CalcContext;
  reload: () => Promise<void>;
  ready: boolean;
}
const Ctx = createContext<RefData | null>(null);

export function RefDataProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState<Omit<RefData, 'reload' | 'ctx' | 'ready'> | null>(null);
  const load = useCallback(async () => {
    const [cat, rules, settings, assets, packages] = await Promise.all([
      cached('catalog', () => api('/api/catalog')),
      cached('rules', () => api('/api/rules/active')),
      cached('settings', () => api('/api/settings')),
      cached('assets', () => api('/api/assets')).catch(() => []),
      cached('packages', () => api('/api/packages')).catch(() => []),
    ]);
    setS({ catalog: cat.items, catalogVersion: cat.version, rules, settings, assets, packages });
  }, []);
  useEffect(() => { void load().catch(() => undefined); }, [load]);
  const value = useMemo<RefData>(() => {
    const base = s ?? { catalog: [], catalogVersion: 'cat-0', rules: null, settings: {}, assets: [], packages: [] };
    const tax = base.settings?.tax ?? { configured: false };
    return { ...base, ctx: { catalog: base.catalog, catalogVersion: base.catalogVersion, rules: base.rules, tax: { configured: !!tax.configured, ratePct: tax.ratePct, base: tax.base } }, reload: load, ready: !!s };
  }, [s, load]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useRef_ = () => useContext(Ctx)!;
export { useRef_ as useRefData };

/** Find an authorised product image for a catalog item / group. */
export function assetFor(assets: Asset[], q: { sku?: string; brand?: string; collection?: string; color?: string; style?: string }): Asset | undefined {
  const usable = assets.filter((a) => a.permission_status !== 'unknown' || true);
  return (
    (q.sku && usable.find((a) => a.sku === q.sku)) ||
    usable.find((a) => a.brand === q.brand && a.collection === q.collection && a.color === q.color && (!q.style || a.style === q.style)) ||
    usable.find((a) => a.brand === q.brand && a.collection === q.collection && !a.color && (!q.color)) ||
    undefined
  );
}
