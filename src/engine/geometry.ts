/**
 * Plan geometry. Coordinate convention: x to the right, y away from the house
 * (plan view, y up). Lengths in inches. Shapes are converted to simple polygons
 * (counter-clockwise rings); overlapping areas are UNIONED (polygon-clipping,
 * Martinez–Rueda) before measuring so shared edges and overlaps never inflate
 * area or perimeter. Cutouts are subtracted.
 */
import polygonClipping, { type MultiPolygon, type Ring } from 'polygon-clipping';
import type { ArcShape, Issue, Pt, Shape } from '../shared/types';
import { sqInToSqFt } from './units';

export const EPS = 1e-6;

export function shoelace(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2; // signed: + = CCW
}

export const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y);

function arcParams(s: ArcShape) {
  const c = dist(s.p1, s.p2);
  const h = Math.abs(s.sagitta);
  const r = (c * c) / (8 * h) + h / 2;
  const half = Math.asin(Math.min(1, c / (2 * r)));
  const theta = h <= r ? 2 * half : 2 * Math.PI - 2 * half; // central angle
  return { c, h, r, theta };
}

export function arcPoints(s: ArcShape): Pt[] {
  const { p1, p2, sagitta } = s;
  const segs = Math.max(2, Math.floor(s.segments));
  const c0 = dist(p1, p2);
  if (c0 < EPS || Math.abs(sagitta) < EPS) return [p1, p2];
  const { c, h, r, theta } = arcParams(s);
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const nx = -(p2.y - p1.y) / c; // unit normal to the left of p1→p2
  const ny = (p2.x - p1.x) / c;
  const sign = sagitta > 0 ? 1 : -1;
  const bulge = { x: mx + sign * nx * h, y: my + sign * ny * h };
  // center is on the normal through the midpoint, r away from the bulge point
  const cx = bulge.x - sign * nx * r;
  const cy = bulge.y - sign * ny * r;
  const a1 = Math.atan2(p1.y - cy, p1.x - cx);
  const ab = Math.atan2(bulge.y - cy, bulge.x - cx);
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  const sweep = Math.abs(wrap(a1 + theta / 2 - ab)) < Math.abs(wrap(a1 - theta / 2 - ab)) ? theta : -theta;
  const out: Pt[] = [];
  for (let i = 0; i <= segs; i++) {
    const a = a1 + (sweep * i) / segs;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  out[0] = { ...p1 };
  out[segs] = { ...p2 };
  return out;
}

/** Arc approximation accuracy: area of the true circular segment vs. the chorded polygon. */
export function arcAccuracy(s: ArcShape): { trueAreaSqIn: number; approxAreaSqIn: number; errorPct: number; label: string } {
  if (dist(s.p1, s.p2) < EPS || Math.abs(s.sagitta) < EPS) return { trueAreaSqIn: 0, approxAreaSqIn: 0, errorPct: 0, label: 'flat' };
  const { r, theta } = arcParams(s);
  const trueArea = (r * r * (theta - Math.sin(theta))) / 2;
  const approx = Math.abs(shoelace(arcPoints(s)));
  const errorPct = trueArea > 0 ? ((trueArea - approx) / trueArea) * 100 : 0;
  return {
    trueAreaSqIn: trueArea,
    approxAreaSqIn: approx,
    errorPct,
    label: `Curve approximated by ${s.segments} straight chords (inscribed polygon); area is ${errorPct.toFixed(2)}% below the true circular segment`,
  };
}

/** Convert any shape to its outline (CCW). */
export function shapeToPoints(s: Shape): Pt[] {
  let pts: Pt[];
  switch (s.kind) {
    case 'rect':
      pts = [
        { x: s.x, y: s.y },
        { x: s.x + s.w, y: s.y },
        { x: s.x + s.w, y: s.y + s.h },
        { x: s.x, y: s.y + s.h },
      ];
      break;
    case 'triangle': {
      const yApex = s.y + (s.flip ? -s.height : s.height);
      pts = [{ x: s.x, y: s.y }, { x: s.x + s.base, y: s.y }, { x: s.x + s.apexOffset, y: yApex }];
      break;
    }
    case 'polygon':
      pts = s.points.map((p) => ({ ...p }));
      break;
    case 'arc':
      // closed by the chord p2→p1
      pts = arcPoints(s);
      break;
  }
  if (shoelace(pts) < 0) pts.reverse();
  return pts;
}

/** Direct area formula for each primitive (used for the per-shape breakdown and tests). */
export function shapeArea(s: Shape): { sqIn: number; formula: string } {
  switch (s.kind) {
    case 'rect':
      return { sqIn: s.w * s.h, formula: 'length × width' };
    case 'triangle':
      return { sqIn: (s.base * s.height) / 2, formula: 'base × perpendicular height ÷ 2' };
    case 'polygon':
      return { sqIn: Math.abs(shoelace(s.points)), formula: 'shoelace (surveyor) formula' };
    case 'arc':
      return { sqIn: Math.abs(shoelace(shapeToPoints(s))), formula: `circular segment approximated by ${s.segments} chords` };
  }
}

function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
  const on = (p: Pt, q: Pt, r: Pt) =>
    Math.abs(o(p, q, r)) <= EPS && Math.min(p.x, q.x) - EPS <= r.x && r.x <= Math.max(p.x, q.x) + EPS && Math.min(p.y, q.y) - EPS <= r.y && r.y <= Math.max(p.y, q.y) + EPS;
  return on(c, d, a) || on(c, d, b) || on(a, b, c) || on(a, b, d);
}

/** Validate a shape: ≥3 distinct points, positive area, no self-intersection, positive dimensions. */
export function validateShape(s: Shape): string[] {
  const errs: string[] = [];
  if (s.kind === 'rect' && (!(s.w > 0) || !(s.h > 0))) errs.push(`${s.label}: length and width must be greater than zero`);
  if (s.kind === 'triangle' && (!(s.base > 0) || !(s.height > 0))) errs.push(`${s.label}: base and height must be greater than zero`);
  if (s.kind === 'arc' && !(s.segments >= 2)) errs.push(`${s.label}: curve needs at least 2 segments`);
  const pts = shapeToPoints(s);
  if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
    errs.push(`${s.label}: has missing coordinates`);
    return errs;
  }
  if (pts.length < 3) errs.push(`${s.label}: needs at least 3 corners`);
  if (Math.abs(shoelace(pts)) < EPS) errs.push(`${s.label}: has zero area`);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (Math.abs(i - j) <= 1 || (i === 0 && j === n - 1)) continue;
      if (segIntersect(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) {
        errs.push(`${s.label}: edges ${i + 1} and ${j + 1} cross — the outline intersects itself`);
        return errs;
      }
    }
  }
  for (let i = 0; i < n; i++) if (dist(pts[i], pts[(i + 1) % n]) < EPS) errs.push(`${s.label}: has a repeated corner`);
  return errs;
}

const toRing = (pts: Pt[]): Ring => {
  const r = pts.map((p) => [p.x, p.y] as [number, number]);
  r.push([pts[0].x, pts[0].y]);
  return r;
};

export interface SourceEdge { key: string; shapeId: string; index: number; a: Pt; b: Pt; length: number }

export function shapeEdges(s: Shape): SourceEdge[] {
  const pts = shapeToPoints(s);
  return pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length];
    return { key: `${s.id}:${i}`, shapeId: s.id, index: i, a, b, length: dist(a, b) };
  });
}

/** An edge of the unioned outline, with the source-shape edge it lies on. */
export interface OutlineEdge {
  a: Pt;
  b: Pt;
  length: number;
  sourceKey?: string;
  /** Parameter (inches from source edge start) of a and b along the source edge. */
  t0?: number;
  t1?: number;
  ring: number;
  polygon: number;
  hole: boolean;
}

export interface GeometryResult {
  valid: boolean;
  issues: Issue[];
  polygons: MultiPolygon;
  /** Each ring of the union as points (outer rings CCW, holes CW). */
  rings: { polygon: number; ring: number; hole: boolean; pts: Pt[] }[];
  areaSqIn: number;
  areaSqFt: number;
  /** Sum of per-shape areas before union (for showing what union removed). */
  grossShapeAreaSqIn: number;
  perimeterIn: number;
  edges: OutlineEdge[];
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  perShape: { id: string; label: string; areaSqIn: number; formula: string; accuracy?: string }[];
}

function pointOnSegmentParam(e: SourceEdge, p: Pt, tol = 0.01): number | null {
  const dx = e.b.x - e.a.x;
  const dy = e.b.y - e.a.y;
  const L = e.length;
  if (L < EPS) return null;
  const t = ((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / L;
  const cross = Math.abs((p.x - e.a.x) * dy - (p.y - e.a.y) * dx) / L;
  if (cross > tol) return null;
  if (t < -tol || t > L + tol) return null;
  return Math.min(L, Math.max(0, t));
}

export function computeGeometry(shapes: Shape[], cutouts: Shape[] = []): GeometryResult {
  const issues: Issue[] = [];
  const empty: GeometryResult = {
    valid: false, issues, polygons: [], rings: [], areaSqIn: 0, areaSqFt: 0, grossShapeAreaSqIn: 0,
    perimeterIn: 0, edges: [], bbox: { minX: 0, minY: 0, maxX: 0, maxY: 0 }, perShape: [],
  };
  if (!shapes.length) {
    issues.push({ id: 'geo-empty', severity: 'blocker', area: 'geometry', message: 'No deck area drawn or measured yet', hint: 'Add a rectangle or draw the outline in Geometry.' });
    return empty;
  }
  for (const s of [...shapes, ...cutouts]) {
    for (const e of validateShape(s)) issues.push({ id: `geo-invalid-${s.id}`, severity: 'blocker', area: 'geometry', message: e });
  }
  if (issues.length) return { ...empty, issues };

  const perShape = shapes.map((s) => {
    const a = shapeArea(s);
    return { id: s.id, label: s.label, areaSqIn: a.sqIn, formula: a.formula, accuracy: s.kind === 'arc' ? arcAccuracy(s).label : undefined };
  });
  for (const s of shapes) {
    if (s.kind === 'arc') issues.push({ id: `geo-approx-${s.id}`, severity: 'info', area: 'geometry', message: arcAccuracy(s).label });
  }

  let union: MultiPolygon = polygonClipping.union(...(shapes.map((s) => [toRing(shapeToPoints(s))]) as [any, ...any[]]));
  if (cutouts.length) union = polygonClipping.difference(union, ...cutouts.map((s) => [toRing(shapeToPoints(s))]) as any);

  const rings: GeometryResult['rings'] = [];
  let area = 0;
  let perim = 0;
  const allSource = [...shapes, ...cutouts].flatMap(shapeEdges);
  const edges: OutlineEdge[] = [];
  union.forEach((poly, pi) => {
    poly.forEach((ring, ri) => {
      const pts = ring.slice(0, -1).map(([x, y]) => ({ x, y }));
      const hole = ri > 0;
      rings.push({ polygon: pi, ring: ri, hole, pts });
      area += hole ? -Math.abs(shoelace(pts)) : Math.abs(shoelace(pts));
      for (let i = 0; i < pts.length; i++) {
        const A = pts[i];
        const B = pts[(i + 1) % pts.length];
        const LL = dist(A, B);
        if (LL < EPS) continue;
        perim += LL;
        // Split the union edge at every source-shape vertex lying on it, so each
        // piece maps to exactly one source edge (e.g. a top edge spanning two areas).
        const ux = (B.x - A.x) / LL, uy = (B.y - A.y) / LL;
        const cuts = [0, LL];
        for (const se of allSource) for (const v of [se.a, se.b]) {
          const t = (v.x - A.x) * ux + (v.y - A.y) * uy;
          const off = Math.abs((v.x - A.x) * uy - (v.y - A.y) * ux);
          if (off < 0.01 && t > 0.01 && t < LL - 0.01) cuts.push(t);
        }
        cuts.sort((x, y) => x - y);
        for (let k = 0; k + 1 < cuts.length; k++) {
        if (cuts[k + 1] - cuts[k] < 0.01) continue;
        const a = { x: A.x + ux * cuts[k], y: A.y + uy * cuts[k] };
        const b = { x: A.x + ux * cuts[k + 1], y: A.y + uy * cuts[k + 1] };
        const L = cuts[k + 1] - cuts[k];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        let src: SourceEdge | undefined;
        let t0: number | undefined, t1: number | undefined;
        for (const se of allSource) {
          if (pointOnSegmentParam(se, mid) === null) continue;
          const ta = pointOnSegmentParam(se, a);
          const tb = pointOnSegmentParam(se, b);
          if (ta === null || tb === null) continue;
          src = se; t0 = ta; t1 = tb;
          break;
        }
        edges.push({ a, b, length: L, sourceKey: src?.key, t0, t1, ring: ri, polygon: pi, hole });
        }
      }
    });
  });

  const xs = rings.flatMap((r) => r.pts.map((p) => p.x));
  const ys = rings.flatMap((r) => r.pts.map((p) => p.y));
  if (union.length > 1) {
    issues.push({ id: 'geo-disconnected', severity: 'review', area: 'geometry', message: `Deck consists of ${union.length} separate areas that do not touch`, hint: 'Confirm they are separate decks or connect them.' });
  }
  return {
    valid: true,
    issues,
    polygons: union,
    rings,
    areaSqIn: area,
    areaSqFt: sqInToSqFt(area),
    grossShapeAreaSqIn: perShape.reduce((s, p) => s + p.areaSqIn, 0),
    perimeterIn: perim,
    edges,
    bbox: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    perShape,
  };
}

// ───────────── Projection helpers used by framing / decking ─────────────

export const unit = (deg: number): Pt => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) });
export const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;

/**
 * Intersect the infinite line { p : dot(p, n) = c } with the polygon set and
 * return interior segments as [tStart, tEnd] measured along direction d (d ⟂ n).
 * Uses the even–odd rule on all rings (outer + holes).
 */
export function lineSegments(rings: Pt[][], n: Pt, c: number, d: Pt): [number, number][] {
  const ts: number[] = [];
  for (const pts of rings) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const fa = dot(a, n) - c;
      const fb = dot(b, n) - c;
      // half-open rule avoids double counting vertices exactly on the line
      if ((fa > 0) === (fb > 0)) continue;
      const t = fa / (fa - fb);
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      ts.push(dot(p, d));
    }
  }
  ts.sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) if (ts[i + 1] - ts[i] > EPS) out.push([ts[i], ts[i + 1]]);
  return out;
}

/** Clip the polygon set to a strip  lo ≤ dot(p,n) ≤ hi  and return the extents along d of each piece. */
export function stripExtents(polys: MultiPolygon, n: Pt, lo: number, hi: number, d: Pt): [number, number][] {
  // Build the strip as a large rectangle in world space.
  const BIG = 1e6;
  const corners = [
    { s: lo, t: -BIG }, { s: hi, t: -BIG }, { s: hi, t: BIG }, { s: lo, t: BIG },
  ].map(({ s, t }) => [n.x * s + d.x * t, n.y * s + d.y * t] as [number, number]);
  corners.push(corners[0]);
  const clipped = polygonClipping.intersection(polys, [[corners]] as any);
  const out: [number, number][] = [];
  for (const poly of clipped) {
    const ts = poly[0].map(([x, y]) => x * d.x + y * d.y);
    const lo2 = Math.min(...ts);
    const hi2 = Math.max(...ts);
    if (hi2 - lo2 > EPS) out.push([lo2, hi2]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/**
 * Inset the union outline by `inset` inches (used for picture-frame borders).
 * Uses mitred parallel offsets per ring; returns null if the result degenerates
 * (then the caller flags the border for manual review instead of guessing).
 */
export function insetRings(rings: { hole: boolean; pts: Pt[] }[], inset: number): Pt[][] | null {
  const out: Pt[][] = [];
  for (const r of rings) {
    const pts = r.pts;
    const n = pts.length;
    // Outer rings are CCW: the interior is to the left; holes are CW: interior (of deck) is to the left too.
    const lines = pts.map((a, i) => {
      const b = pts[(i + 1) % n];
      const L = dist(a, b);
      const nx = -(b.y - a.y) / L;
      const ny = (b.x - a.x) / L;
      return { a: { x: a.x + nx * inset, y: a.y + ny * inset }, b: { x: b.x + nx * inset, y: b.y + ny * inset } };
    });
    const res: Pt[] = [];
    for (let i = 0; i < n; i++) {
      const l1 = lines[(i - 1 + n) % n];
      const l2 = lines[i];
      const d1 = { x: l1.b.x - l1.a.x, y: l1.b.y - l1.a.y };
      const d2 = { x: l2.b.x - l2.a.x, y: l2.b.y - l2.a.y };
      const den = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(den) < EPS) {
        res.push(l2.a);
        continue;
      }
      const t = ((l2.a.x - l1.a.x) * d2.y - (l2.a.y - l1.a.y) * d2.x) / den;
      res.push({ x: l1.a.x + d1.x * t, y: l1.a.y + d1.y * t });
    }
    const a0 = shoelace(pts);
    const a1 = shoelace(res);
    if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < EPS) {
      if (r.hole) continue; // hole grew past nothing — acceptable to drop
      return null;
    }
    for (let i = 0; i < res.length; i++)
      for (let j = i + 2; j < res.length; j++) {
        if (i === 0 && j === res.length - 1) continue;
        if (segIntersect(res[i], res[(i + 1) % res.length], res[j], res[(j + 1) % res.length])) return null;
      }
    out.push(res);
  }
  return out;
}
