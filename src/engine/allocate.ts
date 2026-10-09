/**
 * Stock allocation (1-D cutting). Documented method: FIRST-FIT DECREASING with
 * BEST-FIT remainder selection.
 *
 *   1. Sort required cuts longest → shortest.
 *   2. For each cut, look for an already-opened board whose remaining length
 *      ≥ cut + kerf and whose remainder is ≥ the reusable-offcut minimum; choose
 *      the one leaving the smallest remainder (best fit).
 *   3. Otherwise open a new board using the SHORTEST stock length that fits.
 *   4. A cut longer than the longest stock length is split into pieces at the
 *      longest stock length (each split creates a SEAM that needs framing support;
 *      the caller is told how many seams were created).
 *
 * This is deterministic and traceable, but it is a heuristic — it does NOT
 * guarantee the globally minimal purchase. The UI states that.
 */

export interface Stock { lengthIn: number; sku?: string; catalogId?: string }
export interface Cut { id: string; lengthIn: number; label?: string }

export interface PurchasedBoard {
  n: number;
  stock: Stock;
  cuts: { id: string; lengthIn: number; label?: string }[];
  usedIn: number;
  remainderIn: number;
}

export interface Allocation {
  method: string;
  boards: PurchasedBoard[];
  byStock: { lengthIn: number; sku?: string; catalogId?: string; count: number }[];
  totalCutIn: number;
  totalPurchasedIn: number;
  wasteIn: number;
  wastePct: number;
  seams: number;
  splitCuts: string[];
}

export const ALLOCATION_METHOD = 'first-fit decreasing, best-fit offcut reuse, shortest-stock-that-fits (heuristic; not guaranteed optimal)';

export function allocate(cutsIn: Cut[], stocks: Stock[], opts: { kerfIn: number; minReusableIn: number }): Allocation {
  const sorted = [...stocks].filter((s) => s.lengthIn > 0).sort((a, b) => a.lengthIn - b.lengthIn);
  if (!sorted.length) throw new Error('No stock lengths configured');
  const longest = sorted[sorted.length - 1].lengthIn;
  const cuts: Cut[] = [];
  let seams = 0;
  const splitCuts: string[] = [];
  for (const c of cutsIn) {
    if (c.lengthIn <= 0) continue;
    if (c.lengthIn <= longest + 1e-9) {
      cuts.push(c);
      continue;
    }
    splitCuts.push(c.id);
    let rest = c.lengthIn;
    let k = 0;
    while (rest > longest + 1e-9) {
      cuts.push({ id: `${c.id}#${++k}`, lengthIn: longest, label: c.label });
      rest -= longest;
      seams++;
    }
    cuts.push({ id: `${c.id}#${++k}`, lengthIn: rest, label: c.label });
  }
  cuts.sort((a, b) => b.lengthIn - a.lengthIn || a.id.localeCompare(b.id));

  const boards: PurchasedBoard[] = [];
  for (const c of cuts) {
    let best: PurchasedBoard | null = null;
    for (const b of boards) {
      if (b.remainderIn < opts.minReusableIn - 1e-9) continue;
      const need = c.lengthIn + opts.kerfIn;
      if (b.remainderIn + 1e-9 >= need || Math.abs(b.remainderIn - c.lengthIn) < 1e-9) {
        if (!best || b.remainderIn < best.remainderIn) best = b;
      }
    }
    if (best) {
      const used = Math.min(best.remainderIn, c.lengthIn + opts.kerfIn);
      best.cuts.push({ id: c.id, lengthIn: c.lengthIn, label: c.label });
      best.usedIn += used;
      best.remainderIn -= used;
      continue;
    }
    const stock = sorted.find((s) => s.lengthIn + 1e-9 >= c.lengthIn)!;
    const used = Math.min(stock.lengthIn, c.lengthIn + opts.kerfIn);
    boards.push({ n: boards.length + 1, stock, cuts: [{ id: c.id, lengthIn: c.lengthIn, label: c.label }], usedIn: used, remainderIn: stock.lengthIn - used });
  }
  const byStockMap = new Map<number, { lengthIn: number; sku?: string; catalogId?: string; count: number }>();
  for (const b of boards) {
    const e = byStockMap.get(b.stock.lengthIn) ?? { lengthIn: b.stock.lengthIn, sku: b.stock.sku, catalogId: b.stock.catalogId, count: 0 };
    e.count++;
    byStockMap.set(b.stock.lengthIn, e);
  }
  const totalCut = cuts.reduce((s, c) => s + c.lengthIn, 0);
  const totalPurchased = boards.reduce((s, b) => s + b.stock.lengthIn, 0);
  return {
    method: ALLOCATION_METHOD,
    boards,
    byStock: [...byStockMap.values()].sort((a, b) => a.lengthIn - b.lengthIn),
    totalCutIn: totalCut,
    totalPurchasedIn: totalPurchased,
    wasteIn: totalPurchased - totalCut,
    wastePct: totalPurchased > 0 ? ((totalPurchased - totalCut) / totalPurchased) * 100 : 0,
    seams,
    splitCuts,
  };
}
