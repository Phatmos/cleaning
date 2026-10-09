/**
 * Railing runs from tagged edges.
 *
 * 1. Take outline edges whose source edge is tagged `rail` (house edges never
 *    receive rail even if tagged — flagged instead).
 * 2. Subtract gate and stair openings (interval along the source edge).
 * 3. Join contiguous pieces around each ring into RUNS. A run continues through
 *    a corner when both neighbouring pieces touch that vertex.
 * 4. Each straight leg of a run is divided into sections:
 *        sections = ceil(legLength ÷ maxSpan)        (maxSpan from the system spec)
 *    Posts for an open run = Σ sections + 1  (corner posts shared, counted once).
 *    Posts for a closed loop  = Σ sections.
 * 5. Each section consumes one section kit: the shortest kit whose max span
 *    covers the installed section length (installed ≤ stock; cut-down noted).
 */
import type { CatalogItem, Issue, Opening, Pt } from '../shared/types';
import type { GeometryResult } from './geometry';

export interface RailLeg { a: Pt; b: Pt; lengthIn: number; sections: number; sectionLengthIn: number; kitSku?: string; kitMaxSpanIn?: number }
export interface RailRun { id: string; legs: RailLeg[]; closed: boolean; lengthIn: number; posts: number; cornerPosts: number }

export interface RailingResult {
  runs: RailRun[];
  totalLengthIn: number;
  sections: number;
  posts: number;
  sharedCornerPosts: number;
  openingsApplied: { id: string; kind: string; widthIn: number }[];
  kits: Record<string, number>;
  issues: Issue[];
}

export function computeRailing(
  geo: GeometryResult,
  edgeTags: Record<string, { side: 'house' | 'open'; rail?: boolean }>,
  openings: Opening[],
  kits: CatalogItem[], // railing-section items of the selected system
): RailingResult {
  const issues: Issue[] = [];
  const res: RailingResult = { runs: [], totalLengthIn: 0, sections: 0, posts: 0, sharedCornerPosts: 0, openingsApplied: [], kits: {}, issues };
  const usableKits = kits.filter((k) => k.spec?.maxSpanIn && k.spec.maxSpanIn > 0).sort((a, b) => a.spec!.maxSpanIn! - b.spec!.maxSpanIn!);
  const maxSpan = usableKits.length ? usableKits[usableKits.length - 1].spec!.maxSpanIn! : 0;
  if (!usableKits.length) issues.push({ id: 'rail-kit-missing', severity: 'blocker', area: 'railing', message: 'Selected railing system has no section kit with a maximum span in the catalog', hint: 'Add the system\'s section kits with max post spacing in Admin › Catalog.' });

  for (const [k, t] of Object.entries(edgeTags)) if (t.side === 'house' && t.rail) issues.push({ id: `rail-house-${k}`, severity: 'review', area: 'railing', message: `Edge ${k} is a house edge but marked for railing — ignored` });

  // Build pieces per ring in ring order
  type Piece = { a: Pt; b: Pt; L: number; startsAtVertex: boolean; endsAtVertex: boolean; edgeIdx: number };
  const byRing = new Map<string, typeof geo.edges>();
  for (const e of geo.edges) {
    const key = `${e.polygon}:${e.ring}`;
    if (!byRing.has(key)) byRing.set(key, []);
    byRing.get(key)!.push(e);
  }
  let runN = 0;
  for (const [, edges] of byRing) {
    const pieces: Piece[] = [];
    edges.forEach((e, idx) => {
      const tag = e.sourceKey ? edgeTags[e.sourceKey] : undefined;
      if (!tag?.rail || tag.side === 'house') return;
      // openings on this edge in this edge's local parameter (0..L from e.a)
      const cut: [number, number][] = [];
      for (const o of openings.filter((o) => o.edgeKey === e.sourceKey)) {
        if (e.t0 === undefined || e.t1 === undefined) continue;
        const forward = e.t1 >= e.t0;
        const lo = o.offsetIn, hi = o.offsetIn + o.widthIn;
        const a = forward ? lo - e.t0 : e.t0 - hi;
        const b = forward ? hi - e.t0 : e.t0 - lo;
        const ca = Math.max(0, a), cb = Math.min(e.length, b);
        if (cb > ca) {
          cut.push([ca, cb]);
          if (!res.openingsApplied.find((x) => x.id === o.id)) res.openingsApplied.push({ id: o.id, kind: o.kind, widthIn: o.widthIn });
        }
      }
      cut.sort((x, y) => x[0] - y[0]);
      let t = 0;
      const dir = { x: (e.b.x - e.a.x) / e.length, y: (e.b.y - e.a.y) / e.length };
      const at = (s: number) => ({ x: e.a.x + dir.x * s, y: e.a.y + dir.y * s });
      const intervals: [number, number][] = [];
      for (const [ca, cb] of cut) {
        if (ca > t + 1e-6) intervals.push([t, ca]);
        t = Math.max(t, cb);
      }
      if (e.length > t + 1e-6) intervals.push([t, e.length]);
      for (const [s0, s1] of intervals)
        pieces.push({ a: at(s0), b: at(s1), L: s1 - s0, startsAtVertex: s0 < 1e-6, endsAtVertex: Math.abs(s1 - e.length) < 1e-6, edgeIdx: idx });
    });
    if (!pieces.length) continue;
    // Group into runs: consecutive pieces where prev ends at vertex i+1 and next starts at that vertex.
    const n = edges.length;
    const connects = (p: Piece, q: Piece) => p.endsAtVertex && q.startsAtVertex && (p.edgeIdx + 1) % n === q.edgeIdx;
    const groups: Piece[][] = [];
    for (const p of pieces) {
      const last = groups[groups.length - 1];
      if (last && connects(last[last.length - 1], p)) last.push(p);
      else groups.push([p]);
    }
    let closed = false;
    if (groups.length > 1) {
      const first = groups[0], last = groups[groups.length - 1];
      if (connects(last[last.length - 1], first[0])) groups[0] = [...groups.pop()!, ...first];
    } else if (groups.length === 1 && connects(groups[0][groups[0].length - 1], groups[0][0])) closed = true;

    for (const g of groups) {
      // merge collinear consecutive pieces into legs
      const legs: { a: Pt; b: Pt; L: number }[] = [];
      for (const p of g) {
        const prev = legs[legs.length - 1];
        if (prev) {
          const cross = (prev.b.x - prev.a.x) * (p.b.y - p.a.y) - (prev.b.y - prev.a.y) * (p.b.x - p.a.x);
          if (Math.abs(cross) / (prev.L * p.L) < 1e-6) {
            prev.b = p.b;
            prev.L += p.L;
            continue;
          }
        }
        legs.push({ a: p.a, b: p.b, L: p.L });
      }
      const outLegs: RailLeg[] = legs.map((l) => {
        const sections = maxSpan ? Math.ceil(l.L / maxSpan - 1e-9) : 0;
        const sectionLen = sections ? l.L / sections : 0;
        const kit = usableKits.find((k) => k.spec!.maxSpanIn! + 1e-9 >= sectionLen);
        if (kit) res.kits[kit.sku] = (res.kits[kit.sku] ?? 0) + sections;
        return { a: l.a, b: l.b, lengthIn: l.L, sections, sectionLengthIn: sectionLen, kitSku: kit?.sku, kitMaxSpanIn: kit?.spec?.maxSpanIn };
      });
      const sec = outLegs.reduce((s, l) => s + l.sections, 0);
      const corner = closed ? outLegs.length : outLegs.length - 1;
      const posts = closed ? sec : sec + 1;
      const L = outLegs.reduce((s, l) => s + l.lengthIn, 0);
      res.runs.push({ id: `Run ${++runN}`, legs: outLegs, closed, lengthIn: L, posts, cornerPosts: corner });
      res.totalLengthIn += L;
      res.sections += sec;
      res.posts += posts;
      res.sharedCornerPosts += corner;
    }
  }
  for (const o of openings) if (!res.openingsApplied.find((x) => x.id === o.id)) {
    const tag = edgeTags[o.edgeKey];
    if (tag?.rail) issues.push({ id: `opening-miss-${o.id}`, severity: 'review', area: 'railing', message: `${o.kind === 'gate' ? 'Gate' : 'Stair'} opening ${o.id} does not fall on the outline of its edge` });
  }
  return res;
}

/** Block incompatible product combinations: accessories/infill/colours must list the system. */
export function railingCompatibility(system: string | undefined, color: string | undefined, picks: CatalogItem[]): Issue[] {
  const issues: Issue[] = [];
  if (!system) return issues;
  for (const p of picks) {
    const sys = p.spec?.railingSystem;
    const compat = p.spec?.compatibleSystems;
    if ((sys && sys !== system) || (compat && !compat.includes(system)))
      issues.push({ id: `rail-incompatible-${p.sku}`, severity: 'blocker', area: 'railing', message: `${p.description} (${p.sku}) is not compatible with the ${system} railing system` });
    if (color && p.spec?.colors && !p.spec.colors.includes(color))
      issues.push({ id: `rail-color-${p.sku}`, severity: 'blocker', area: 'railing', message: `${p.description} is not offered in ${color}` });
  }
  return issues;
}
