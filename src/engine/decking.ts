/**
 * Decking rows, picture frame, fascia and hidden-fastener takeoff.
 *
 * ROWS: boards run along direction b = deckingAngle. Rows stack along the
 * perpendicular axis m. Row i occupies the strip [m0 + i·p, m0 + i·p + w] where
 * w = actual board width and p = w + gap. Row count = ceil((M + gap) / p) where
 * M is the field depth along m. Each strip is clipped against the field polygon
 * (outline minus picture-frame courses); every resulting piece's extent along b
 * becomes one cut (so angled/curved edges are covered by the longer side of the
 * strip). Cuts are mapped to stock with `allocate` (see its documented method).
 *
 * PICTURE FRAME: each course is one board laid along every outline edge; cut
 * length = edge length at that course's centreline (mitred). Field = outline
 * inset by courses·(w + gap).
 *
 * FASTENERS: board-to-joist crossings are counted exactly — for each field cut,
 * the number of joist lines whose position falls inside the cut's projection
 * onto the across-joist axis. Fasteners = crossings × perCrossing from the
 * selected fastener's product spec, then packed by its box quantity.
 */
import type { Issue, Pt } from '../shared/types';
import { allocate, type Allocation, type Stock } from './allocate';
import { dot, insetRings, stripExtents, unit, type GeometryResult, type OutlineEdge } from './geometry';
import polygonClipping from 'polygon-clipping';

export interface BoardSpec { widthIn: number; gapIn: number; stocks: Stock[] }

export interface DeckingResult {
  rows: number;
  rowFormula: string;
  fieldCuts: { id: string; lengthIn: number; label: string; a: Pt; b: Pt }[];
  frameCuts: { id: string; lengthIn: number; label: string }[];
  fieldAllocation?: Allocation;
  frameAllocation?: Allocation;
  crossings: number;
  issues: Issue[];
  fieldAreaSqIn: number;
}

export function computeDecking(
  geo: GeometryResult,
  opts: {
    deckingAngleDeg: number;
    board: BoardSpec;
    frameBoard?: BoardSpec;
    frameCourses: number;
    kerfIn: number;
    minReusableIn: number;
    joist?: { n: Pt; positions: number[] };
  },
): DeckingResult {
  const issues: Issue[] = [];
  const { widthIn: w, gapIn: gap } = opts.board;
  const out: DeckingResult = { rows: 0, rowFormula: '', fieldCuts: [], frameCuts: [], crossings: 0, issues, fieldAreaSqIn: 0 };
  if (!(w > 0)) {
    issues.push({ id: 'deck-board-width', severity: 'blocker', area: 'decking', message: 'Selected decking product has no actual board width in the catalog' });
    return out;
  }
  const b = unit(opts.deckingAngleDeg);
  const m = { x: -b.y, y: b.x };

  // Field polygon (minus frame courses)
  let field = geo.polygons;
  const fw = opts.frameBoard?.widthIn ?? w;
  const fgap = opts.frameBoard?.gapIn ?? gap;
  if (opts.frameCourses > 0) {
    const inset = opts.frameCourses * (fw + fgap);
    const insetPts = insetRings(geo.rings, inset);
    if (!insetPts) {
      issues.push({ id: 'frame-inset', severity: 'review', area: 'decking', message: 'Picture-frame border could not be offset automatically for this outline', hint: 'Enter frame quantities as an override with a reason.' });
    } else {
      const rings = insetPts.map((pts) => {
        const r = pts.map((p) => [p.x, p.y] as [number, number]);
        r.push(r[0]);
        return r;
      });
      // Even-odd: union outer rings, subtract holes (re-run through clipping to normalise)
      field = (polygonClipping.union as any)(...rings.filter((_, i) => !geo.rings[i]?.hole).map((r) => [r]) as any);
      const holes = rings.filter((_, i) => geo.rings[i]?.hole);
      if (holes.length) field = polygonClipping.difference(field, ...holes.map((r) => [r]) as any);
    }
    // Frame cuts: per edge per course, centreline length (mitred corners)
    for (let c = 0; c < opts.frameCourses; c++) {
      const off = c * (fw + fgap) + fw / 2;
      const center = insetRings(geo.rings, off);
      if (!center) continue;
      center.forEach((pts, ri) => {
        pts.forEach((a, i) => {
          const q = pts[(i + 1) % pts.length];
          // mitred board length = centreline length + one board width allowance for the mitre
          const L = Math.hypot(q.x - a.x, q.y - a.y) + fw;
          out.frameCuts.push({ id: `F${c + 1}-${ri + 1}-${i + 1}`, lengthIn: L, label: `Frame course ${c + 1}, edge ${i + 1}` });
        });
      });
    }
  }
  let fieldArea = 0;
  for (const poly of field) poly.forEach((ring, i) => {
    let a = 0;
    for (let k = 0; k + 1 < ring.length; k++) a += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
    fieldArea += (i === 0 ? 1 : -1) * Math.abs(a / 2);
  });
  out.fieldAreaSqIn = fieldArea;

  const allPts = field.flatMap((p) => p.flatMap((r) => r.map(([x, y]) => ({ x, y }))));
  if (!allPts.length) {
    issues.push({ id: 'deck-field-empty', severity: 'blocker', area: 'decking', message: 'No decking field remains after borders' });
    return out;
  }
  const mMin = Math.min(...allPts.map((p) => dot(p, m)));
  const mMax = Math.max(...allPts.map((p) => dot(p, m)));
  const M = mMax - mMin;
  const p = w + gap;
  const rows = Math.ceil((M + gap) / p - 1e-9);
  out.rows = rows;
  out.rowFormula = `ceil((${r2(M)}" field depth + ${r2(gap)}" gap) ÷ (${r2(w)}" board + ${r2(gap)}" gap)) = ${rows} rows`;
  for (let i = 0; i < rows; i++) {
    const lo = mMin + i * p;
    const hi = Math.min(lo + w, mMax);
    const ext = stripExtents(field, m, lo, Math.max(hi, lo + 0.01), b);
    ext.forEach(([t0, t1], k) => {
      const mid = (lo + hi) / 2;
      const A = { x: b.x * t0 + m.x * mid, y: b.y * t0 + m.y * mid };
      const B = { x: b.x * t1 + m.x * mid, y: b.y * t1 + m.y * mid };
      out.fieldCuts.push({ id: `D${i + 1}${ext.length > 1 ? String.fromCharCode(97 + k) : ''}`, lengthIn: t1 - t0, label: `Row ${i + 1}`, a: A, b: B });
    });
  }
  if (opts.board.stocks.length) {
    out.fieldAllocation = allocate(out.fieldCuts, opts.board.stocks, { kerfIn: opts.kerfIn, minReusableIn: opts.minReusableIn });
    if (out.fieldAllocation.seams > 0)
      issues.push({ id: 'deck-seams', severity: 'info', area: 'decking', message: `${out.fieldAllocation.seams} butt seam(s) needed — rows longer than the longest stock board`, hint: 'Seams need doubled joists or blocking per the decking manufacturer.' });
    const frameStocks = opts.frameBoard?.stocks ?? opts.board.stocks;
    if (out.frameCuts.length && frameStocks.length) out.frameAllocation = allocate(out.frameCuts, frameStocks, { kerfIn: opts.kerfIn, minReusableIn: opts.minReusableIn });
  } else {
    issues.push({ id: 'deck-stock-missing', severity: 'blocker', area: 'decking', message: 'Selected decking has no stock lengths in the catalog' });
  }
  if (opts.joist) {
    const { n, positions } = opts.joist;
    for (const c of out.fieldCuts) {
      const a = dot(c.a, n);
      const z = dot(c.b, n);
      const lo = Math.min(a, z) - 1e-6;
      const hi = Math.max(a, z) + 1e-6;
      out.crossings += positions.filter((q) => q >= lo && q <= hi).length;
    }
  }
  return out;
}

/** Fascia: selected exposed edges; rows = ceil(exposed rim depth / fascia board height). */
export function computeFascia(edges: OutlineEdge[], tags: Record<string, { fascia?: boolean }>, opts: { boardHeightIn?: number; rimDepthIn?: number; rowsOverride?: number }) {
  const issues: Issue[] = [];
  const selected = edges.filter((e) => e.sourceKey && tags[e.sourceKey]?.fascia);
  let rows = opts.rowsOverride ?? 0;
  let formula = '';
  if (!opts.rowsOverride) {
    if (!opts.boardHeightIn || !opts.rimDepthIn) {
      issues.push({ id: 'fascia-dims', severity: 'blocker', area: 'decking', message: 'Fascia rows cannot be calculated: fascia board height or rim depth unknown' });
      rows = 1;
      formula = 'rows assumed 1 pending dimensions';
    } else {
      rows = Math.ceil(opts.rimDepthIn / opts.boardHeightIn - 1e-9);
      formula = `ceil(${opts.rimDepthIn}" rim depth ÷ ${opts.boardHeightIn}" fascia height) = ${rows} row(s)`;
    }
  } else formula = `rows set to ${rows}`;
  const cuts = selected.flatMap((e, i) => Array.from({ length: rows }, (_, r) => ({ id: `FA${i + 1}-${r + 1}`, lengthIn: e.length, label: `Fascia edge ${i + 1} row ${r + 1}` })));
  return { cuts, rows, formula, totalLf: selected.reduce((s, e) => s + e.length, 0) / 12, issues };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
