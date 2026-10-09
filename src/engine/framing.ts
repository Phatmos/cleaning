/**
 * Framing takeoff: joists, rims, ledger, beams, posts.
 *
 * COORDINATE CONVENTION
 *   Joists run along unit vector d = (cos φ, sin φ), φ = joistAngleDeg.
 *   The ACROSS-JOIST axis is n = (−sin φ, cos φ). The deck's "width perpendicular
 *   to the joists" is W = max(n·p) − min(n·p) over the outline.
 *
 * BASE JOIST LINES (boundary joist at each end)
 *   lines = ceil(W / s) + 1, s = maximum on-center spacing (same units).
 *   Lines sit at min, min+s, min+2s … and the last line at max.
 *   Example fixture: W = 240" (20 ft), s = 16" → ceil(15) + 1 = 16 lines.
 *   This verifies COUNTING only — span adequacy is checked separately against a
 *   verified rule set.
 *
 * Joist lines are not purchased pieces: each line is intersected with the
 * outline (concave decks give several pieces per line), each piece becomes a
 * cut, and cuts are mapped to stock. Rims, ledger, doubled members, frame
 * support and seam blocking are listed as separate, additional framing.
 */
import type { BeamInput, Issue, Pt, RuleSet, StructureInput } from '../shared/types';
import { dot, EPS, lineSegments, type GeometryResult, type OutlineEdge } from './geometry';

export interface JoistLine { index: number; pos: number; segments: [number, number][] }

export interface FramingResult {
  d: Pt;
  n: Pt;
  widthAcrossIn: number;
  lengthAlongIn: number;
  baseLineCount: number;
  formula: string;
  lines: JoistLine[];
  joistCuts: { id: string; lengthIn: number; label: string }[];
  extraJoistCuts: { id: string; lengthIn: number; label: string; reason: string }[];
  rimCuts: { id: string; lengthIn: number; label: string }[];
  ledgerCuts: { id: string; lengthIn: number; label: string }[];
  ledgerLengthIn: number;
  hangerCount: number;
  beams: { id: string; lengthIn: number; plies: number; size: string; posts: number; postFormula: string; postSpacingIn?: number; overridden: boolean }[];
  postCount: number;
  supports: number[]; // positions along d of each support (ledger/beams)
  spans: { fromIn: number; toIn: number; spanIn: number }[];
  cantileverIn: number;
  issues: Issue[];
  structuralVerified: boolean;
}

export const joistAxes = (deg: number) => {
  const r = (deg * Math.PI) / 180;
  const d = { x: Math.cos(r), y: Math.sin(r) };
  const n = { x: -Math.sin(r), y: Math.cos(r) };
  return { d, n };
};

/** Pure counting rule for one rectangular bay (exported for fixtures/tests). */
export function baseJoistLines(widthIn: number, maxSpacingIn: number): number {
  if (!(widthIn > 0) || !(maxSpacingIn > 0)) throw new Error('width and spacing must be > 0');
  return Math.ceil(widthIn / maxSpacingIn - 1e-9) + 1;
}

const isParallel = (e: OutlineEdge, d: Pt) => {
  const ex = (e.b.x - e.a.x) / e.length;
  const ey = (e.b.y - e.a.y) / e.length;
  return Math.abs(ex * d.y - ey * d.x) < 0.02; // ≈ 1.1°
};

export function computeFraming(
  geo: GeometryResult,
  joistAngleDeg: number,
  st: StructureInput,
  edgeTags: Record<string, { side: 'house' | 'open'; ledger?: boolean }>,
  rules: RuleSet | null,
  extraFrameSupport: { pictureFrameCourses: number },
): FramingResult {
  const issues: Issue[] = [];
  const { d, n } = joistAxes(joistAngleDeg);
  const ringPts = geo.rings.map((r) => r.pts);
  const allPts = ringPts.flat();
  const nMin = Math.min(...allPts.map((p) => dot(p, n)));
  const nMax = Math.max(...allPts.map((p) => dot(p, n)));
  const dMin = Math.min(...allPts.map((p) => dot(p, d)));
  const dMax = Math.max(...allPts.map((p) => dot(p, d)));
  const W = nMax - nMin;
  const s = st.joist.spacingIn;
  const res: FramingResult = {
    d, n, widthAcrossIn: W, lengthAlongIn: dMax - dMin, baseLineCount: 0, formula: '', lines: [], joistCuts: [], extraJoistCuts: [],
    rimCuts: [], ledgerCuts: [], ledgerLengthIn: 0, hangerCount: 0, beams: [], postCount: 0, supports: [], spans: [], cantileverIn: 0,
    issues, structuralVerified: false,
  };
  if (!s || s <= 0) {
    issues.push({ id: 'joist-spacing-missing', severity: 'blocker', area: 'structure', message: 'Joist on-center spacing is not set', hint: 'Choose 12", 16" or the spacing required by the decking.' });
    return res;
  }
  if (!st.joist.size) issues.push({ id: 'joist-size-missing', severity: 'blocker', area: 'structure', message: 'Joist member size is not set' });
  if (!st.joist.speciesGrade) issues.push({ id: 'joist-grade-missing', severity: 'blocker', area: 'structure', message: 'Joist species/grade is not set' });

  const count = baseJoistLines(W, s);
  res.baseLineCount = count;
  res.formula = `ceil(${round(W)}" ÷ ${s}") + 1 = ${count} base joist lines (boundary joist at each end; width measured perpendicular to joists)`;
  const positions: number[] = [];
  for (let i = 0; i < count - 1; i++) positions.push(nMin + i * s);
  positions.push(nMax);
  const inset = 0.05; // evaluate boundary lines just inside the outline
  positions.forEach((pos, i) => {
    const c = Math.min(Math.max(pos, nMin + inset), nMax - inset);
    const segs = lineSegments(ringPts, n, c, d);
    res.lines.push({ index: i, pos, segments: segs });
    segs.forEach(([a, b], k) => res.joistCuts.push({ id: `J${i + 1}${segs.length > 1 ? String.fromCharCode(97 + k) : ''}`, lengthIn: b - a, label: `Joist line ${i + 1}` }));
  });

  // Edges and their framing role
  for (const e of geo.edges) {
    const tag = e.sourceKey ? edgeTags[e.sourceKey] : undefined;
    const parallel = isParallel(e, d);
    if (tag?.ledger) {
      res.ledgerCuts.push({ id: `L${res.ledgerCuts.length + 1}`, lengthIn: e.length, label: 'Ledger' });
      res.ledgerLengthIn += e.length;
      continue;
    }
    if (parallel) {
      // Is a base joist line already on this edge?
      const p = dot(e.a, n);
      const covered = positions.some((q) => Math.abs(q - p) < 0.5);
      if (!covered) res.extraJoistCuts.push({ id: `XJ${res.extraJoistCuts.length + 1}`, lengthIn: e.length, label: 'Boundary joist', reason: 'Outline edge parallel to joists not on a base line (e.g. inside corner of an L)' });
      continue;
    }
    for (let k = 0; k < Math.max(1, st.joist.rimPlies); k++) res.rimCuts.push({ id: `R${res.rimCuts.length + 1}`, lengthIn: e.length, label: k ? 'Rim (doubled)' : 'Rim / band' });
  }
  // One hanger at each joist piece end that lands on a ledger or a flush rim.
  res.hangerCount = res.joistCuts.length * 2;

  if (extraFrameSupport.pictureFrameCourses > 0) {
    // Company practice (configurable in a future rule set): a doubled joist along
    // each edge that is parallel to the joists, blocking ladder along the others.
    for (const e of geo.edges) {
      if (isParallel(e, d)) res.extraJoistCuts.push({ id: `PF${res.extraJoistCuts.length + 1}`, lengthIn: e.length, label: 'Picture-frame doubled joist', reason: 'Picture-frame border support' });
    }
  }

  // Ledger attachment
  const attached = st.attachment === 'attached';
  if (!st.attachment) issues.push({ id: 'attach-missing', severity: 'blocker', area: 'structure', message: 'Attached vs. freestanding is not answered' });
  if (attached) {
    if (res.ledgerLengthIn === 0) issues.push({ id: 'ledger-edge-missing', severity: 'blocker', area: 'structure', message: 'Deck is attached but no edge is marked as the ledger', hint: 'Tap the house edge and mark it "Ledger".' });
    const sub = st.ledger.substrate;
    if (sub === 'unknown' || sub === 'siding-unknown-backing') issues.push({ id: 'ledger-substrate', severity: 'blocker', area: 'structure', message: 'Ledger attachment substrate is unresolved', hint: 'Confirm the rim joist/band behind the siding, or choose freestanding.' });
    if (sub === 'brick-veneer' && !st.ledger.verifiedDetailRef) issues.push({ id: 'ledger-brick', severity: 'blocker', area: 'structure', message: 'A ledger cannot be assumed to attach to brick veneer', hint: 'Use a freestanding beam at the house or record a verified engineered detail.' });
    if ((sub === 'solid-masonry' || sub === 'concrete-foundation' || sub === 'other') && !st.ledger.verifiedDetailRef) issues.push({ id: 'ledger-detail', severity: 'review', area: 'structure', message: `Ledger to ${sub.replace('-', ' ')} requires a verified attachment detail` });
    if (!st.ledger.flashing || st.ledger.flashing === 'unknown') issues.push({ id: 'ledger-flashing', severity: 'review', area: 'structure', message: 'Ledger flashing condition not recorded' });
  }

  // Beams and posts
  const supports: number[] = [];
  if (attached && res.ledgerLengthIn > 0) supports.push(dMin);
  for (const b of st.beams) supports.push(dMin + b.offsetIn);
  supports.sort((a, b) => a - b);
  res.supports = supports;
  if (!st.beams.length) issues.push({ id: 'beams-missing', severity: 'blocker', area: 'structure', message: 'No beam line entered', hint: 'Add the beam line(s) supporting the joists.' });
  const ruleOk = !!rules && rules.status === 'verified';
  let verified = ruleOk;
  if (!ruleOk) issues.push({ id: 'rules-unverified', severity: 'review', area: 'structure', message: 'No VERIFIED structural rule set is active — framing is counted but not structurally verified', hint: 'An admin must enter and verify span tables (jurisdiction, code edition, source, reviewer).' });

  for (const b of st.beams) {
    const pos = dMin + b.offsetIn;
    if (pos < dMin - EPS || pos > dMax + EPS) issues.push({ id: `beam-out-${b.id}`, severity: 'blocker', area: 'structure', message: `Beam ${b.id} is outside the deck footprint` });
    const segs = lineSegments(ringPts, d, Math.min(Math.max(pos, dMin + 0.05), dMax - 0.05), n);
    const len = segs.reduce((s2, [a, c]) => s2 + (c - a), 0) + 2 * (b.overhangIn ?? 0);
    let posts = 0;
    let postFormula = '';
    if (b.postCountOverride) {
      posts = b.postCountOverride.value;
      postFormula = `override (${b.postCountOverride.reason})`;
    } else if (b.postSpacingIn && b.postSpacingIn > 0) {
      posts = segs.reduce((s2, [a, c]) => s2 + Math.ceil((c - a) / b.postSpacingIn! - 1e-9) + 1, 0);
      postFormula = `Σ per beam piece: ceil(length ÷ ${b.postSpacingIn}") + 1`;
    } else {
      issues.push({ id: `beam-postspacing-${b.id}`, severity: 'blocker', area: 'structure', message: `Beam ${b.id}: post spacing not set` });
    }
    if (ruleOk && b.postSpacingIn) {
      const joistSpan = maxSpanFor(supports, dMax, pos);
      const row = rules!.beamSpans.find((r) => r.speciesGrade === st.joist.speciesGrade && r.size === b.size && r.plies === b.plies && r.joistSpanIn >= joistSpan);
      if (!row) {
        verified = false;
        issues.push({ id: `beam-rule-${b.id}`, severity: 'review', area: 'structure', message: `Beam ${b.id} (${b.plies}-ply ${b.size}) is outside the verified beam table for this joist span`, hint: 'Engineer/manager review required.' });
      } else if (b.postSpacingIn > row.maxPostSpacingIn) {
        verified = false;
        issues.push({ id: `beam-span-${b.id}`, severity: 'blocker', area: 'structure', message: `Beam ${b.id}: post spacing ${b.postSpacingIn}" exceeds verified maximum ${row.maxPostSpacingIn}"` });
      }
    }
    res.beams.push({ id: b.id, lengthIn: len, plies: b.plies, size: b.size, posts, postFormula, postSpacingIn: b.postSpacingIn, overridden: !!b.postCountOverride });
    res.postCount += posts;
  }

  // Joist spans between supports + cantilever
  for (let i = 0; i + 1 < supports.length; i++) res.spans.push({ fromIn: supports[i] - dMin, toIn: supports[i + 1] - dMin, spanIn: supports[i + 1] - supports[i] });
  if (supports.length) {
    if (supports[0] - dMin > EPS) res.spans.unshift({ fromIn: 0, toIn: supports[0] - dMin, spanIn: supports[0] - dMin }); // back cantilever
    res.cantileverIn = dMax - supports[supports.length - 1];
  }
  if (ruleOk && st.joist.size && st.joist.speciesGrade && supports.length) {
    const row = rules!.joistSpans.find((r) => r.speciesGrade === st.joist.speciesGrade && r.size === st.joist.size && r.spacingIn === s);
    if (!row) {
      verified = false;
      issues.push({ id: 'joist-rule-missing', severity: 'review', area: 'structure', message: `No verified span row for ${st.joist.speciesGrade} ${st.joist.size} @ ${s}" o.c.` });
    } else {
      const maxSpan = Math.max(0, ...res.spans.map((x) => x.spanIn));
      if (maxSpan > row.maxSpanIn + EPS) {
        verified = false;
        issues.push({ id: 'joist-overspan', severity: 'blocker', area: 'structure', message: `Joist span ${round(maxSpan)}" exceeds verified maximum ${row.maxSpanIn}" for ${st.joist.size} @ ${s}"` });
      }
      if (row.maxCantileverIn !== undefined && res.cantileverIn > row.maxCantileverIn + EPS) {
        verified = false;
        issues.push({ id: 'joist-cantilever', severity: 'blocker', area: 'structure', message: `Cantilever ${round(res.cantileverIn)}" exceeds verified maximum ${row.maxCantileverIn}"` });
      }
    }
  }
  res.structuralVerified = verified && !issues.some((i) => i.severity === 'blocker');
  return res;
}

function maxSpanFor(supports: number[], dMax: number, pos: number): number {
  const i = supports.indexOf(pos);
  const prev = i > 0 ? pos - supports[i - 1] : 0;
  const next = i >= 0 && i + 1 < supports.length ? supports[i + 1] - pos : dMax - pos;
  return Math.max(prev, next);
}

const round = (x: number) => Math.round(x * 100) / 100;

export type { BeamInput };
