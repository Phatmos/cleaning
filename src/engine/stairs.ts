/**
 * Stairs. All checks come from the active rule set; when a rule is missing the
 * calculation still runs (so the salesman sees quantities) but the result is
 * flagged as unverified and the estimate cannot be marked complete.
 *
 *   risers      = ceil(totalRise ÷ maxRiser)
 *   actualRise  = totalRise ÷ risers
 *   treads      = risers − 1   ('deck-top': the deck surface is the top step)
 *               = risers       ('flush':   a tread is installed flush at the top)
 *   totalRun    = treads × treadDepth
 *   stringerLen = √(totalRise² + totalRun²)  (+ one tread depth seat allowance)
 *   stringers   = ceil(width ÷ maxStringerSpacing) + 1
 *   tread boards per tread = ceil((treadDepth + gap) ÷ (boardWidth + gap))
 */
import type { Issue, RuleSet, StairInput } from '../shared/types';

export interface StairResult {
  id: string;
  label: string;
  complete: boolean;
  risers: number;
  actualRiseIn: number;
  treads: number;
  totalRunIn: number;
  stringerLengthIn: number;
  stringers: number;
  treadBoardsPerTread: number;
  treadCuts: { id: string; lengthIn: number; label: string }[];
  riserCuts: { id: string; lengthIn: number; label: string }[];
  railSides: number;
  railLengthIn: number;
  lights: number;
  formulas: string[];
  issues: Issue[];
}

export function computeStair(
  s: StairInput,
  rules: RuleSet | null,
  board: { widthIn?: number; gapIn?: number },
  riserBoardHeightIn?: number,
): StairResult {
  const issues: Issue[] = [];
  const out: StairResult = {
    id: s.id, label: s.label, complete: false, risers: 0, actualRiseIn: 0, treads: 0, totalRunIn: 0, stringerLengthIn: 0, stringers: 0,
    treadBoardsPerTread: 0, treadCuts: [], riserCuts: [], railSides: (s.railsLeft ? 1 : 0) + (s.railsRight ? 1 : 0), railLengthIn: 0, lights: 0, formulas: [], issues,
  };
  const sr = rules?.status === 'verified' ? rules.stairs : undefined;
  if (!sr) issues.push({ id: `stair-rules-${s.id}`, severity: 'review', area: 'stairs', message: `${s.label}: no verified stair rule set (max riser, min tread, stringer spacing, guard/handrail) — stair is not code-verified` });
  const guardAt = sr?.guardRequiredAboveIn ?? (rules?.status === 'verified' ? rules.guardRequiredAboveIn : undefined);
  if (guardAt === undefined) issues.push({ id: `stair-guard-${s.id}`, severity: 'review', area: 'stairs', message: `${s.label}: guard/handrail requirement not verified (low height does not waive the check)` });
  if (!s.totalRiseIn || s.totalRiseIn <= 0) {
    issues.push({ id: `stair-rise-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: finished elevation difference (total rise) is missing — stair cannot be calculated` });
    return out;
  }
  if (!s.widthIn) issues.push({ id: `stair-width-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: stair width missing` });
  if (!s.treadDepthIn) issues.push({ id: `stair-tread-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: tread depth missing` });
  const maxRiser = sr?.maxRiserIn;
  if (!maxRiser) {
    issues.push({ id: `stair-maxriser-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: maximum riser height is not configured in a verified rule set` });
    return out;
  }
  out.risers = Math.ceil(s.totalRiseIn / maxRiser - 1e-9);
  out.actualRiseIn = s.totalRiseIn / out.risers;
  out.treads = s.topConvention === 'deck-top' ? out.risers - 1 : out.risers;
  out.formulas.push(`risers = ceil(${s.totalRiseIn}" ÷ ${maxRiser}") = ${out.risers}; actual rise = ${r3(out.actualRiseIn)}"`);
  out.formulas.push(`treads = ${s.topConvention === 'deck-top' ? 'risers − 1 (deck is top step)' : 'risers (flush top tread)'} = ${out.treads}`);
  if (sr && s.treadDepthIn && s.treadDepthIn < sr.minTreadIn) issues.push({ id: `stair-tread-min-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: tread depth ${s.treadDepthIn}" is below the verified minimum ${sr.minTreadIn}"` });
  if (sr && s.widthIn && s.widthIn < sr.minWidthIn) issues.push({ id: `stair-width-min-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: width ${s.widthIn}" is below the verified minimum ${sr.minWidthIn}"` });
  if (sr && out.risers >= sr.handrailRequiredAtRisers && !s.railsLeft && !s.railsRight)
    issues.push({ id: `stair-handrail-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: ${out.risers} risers requires a handrail under the verified rules` });
  if (s.treadDepthIn) {
    out.totalRunIn = out.treads * s.treadDepthIn;
    out.formulas.push(`total run = ${out.treads} × ${s.treadDepthIn}" = ${r3(out.totalRunIn)}"`);
    if (s.availableRunIn && out.totalRunIn > s.availableRunIn)
      issues.push({ id: `stair-run-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: needs ${r3(out.totalRunIn)}" of run but only ${s.availableRunIn}" is available — add a landing/turn` });
    out.stringerLengthIn = Math.hypot(s.totalRiseIn, out.totalRunIn) + s.treadDepthIn;
    out.formulas.push(`stringer ≈ √(rise² + run²) + one tread = ${r3(out.stringerLengthIn)}"`);
  }
  const spacing = s.stringerSpacingIn ?? sr?.maxStringerSpacingIn;
  if (s.widthIn && spacing) {
    out.stringers = Math.ceil(s.widthIn / spacing - 1e-9) + 1;
    out.formulas.push(`stringers = ceil(${s.widthIn}" ÷ ${spacing}") + 1 = ${out.stringers}`);
    if (sr && spacing > sr.maxStringerSpacingIn) issues.push({ id: `stair-stringer-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: stringer spacing exceeds verified maximum ${sr.maxStringerSpacingIn}"` });
  } else if (s.widthIn) issues.push({ id: `stair-stringer-sp-${s.id}`, severity: 'blocker', area: 'stairs', message: `${s.label}: stringer spacing unknown (no verified rule and none entered)` });
  if (board.widthIn && s.treadDepthIn && s.widthIn) {
    const gap = board.gapIn ?? 0;
    out.treadBoardsPerTread = Math.ceil((s.treadDepthIn + gap) / (board.widthIn + gap) - 1e-9);
    for (let t = 0; t < out.treads; t++) for (let k = 0; k < out.treadBoardsPerTread; k++) out.treadCuts.push({ id: `${s.id}-T${t + 1}.${k + 1}`, lengthIn: s.widthIn, label: `${s.label} tread ${t + 1}` });
    out.formulas.push(`tread boards/tread = ceil((${s.treadDepthIn}" + gap) ÷ (${board.widthIn}" + gap)) = ${out.treadBoardsPerTread}`);
  }
  if (s.riserBoards && s.widthIn) {
    const perRiser = riserBoardHeightIn ? Math.ceil(out.actualRiseIn / riserBoardHeightIn - 1e-9) : 1;
    if (!riserBoardHeightIn) issues.push({ id: `stair-riserboard-${s.id}`, severity: 'review', area: 'stairs', message: `${s.label}: riser board height unknown — assumed 1 board per riser` });
    for (let r = 0; r < out.risers; r++) for (let k = 0; k < perRiser; k++) out.riserCuts.push({ id: `${s.id}-R${r + 1}.${k + 1}`, lengthIn: s.widthIn, label: `${s.label} riser ${r + 1}` });
  }
  out.railLengthIn = out.railSides * Math.hypot(s.totalRiseIn, out.totalRunIn);
  out.lights = (s.lightsPerRiser ?? 0) * out.risers;
  out.complete = !issues.some((i) => i.severity === 'blocker');
  return out;
}

/**
 * Footing concrete: volume from actual dimensions, bags from the selected
 * product's documented yield, waste configured separately.
 */
export function footingConcrete(spec: { shape: 'round' | 'square'; diameterIn?: number; widthIn?: number; depthIn?: number; pierAboveGradeIn?: number }, count: number, yieldCuFt: number | undefined, wastePct: number) {
  const issues: Issue[] = [];
  const depth = (spec.depthIn ?? 0) + (spec.pierAboveGradeIn ?? 0);
  let cuIn = 0;
  let formula = '';
  if (spec.shape === 'round') {
    if (!spec.diameterIn || !spec.depthIn) issues.push({ id: 'footing-dims', severity: 'blocker', area: 'footings', message: 'Footing diameter and depth are required' });
    const r = (spec.diameterIn ?? 0) / 2;
    cuIn = Math.PI * r * r * depth;
    formula = `π × (${spec.diameterIn}" ÷ 2)² × ${depth}" per footing`;
  } else {
    if (!spec.widthIn || !spec.depthIn) issues.push({ id: 'footing-dims', severity: 'blocker', area: 'footings', message: 'Footing width and depth are required' });
    cuIn = (spec.widthIn ?? 0) ** 2 * depth;
    formula = `${spec.widthIn}" × ${spec.widthIn}" × ${depth}" per footing`;
  }
  const eachCuFt = cuIn / 1728;
  const totalCuFt = eachCuFt * count;
  const withWaste = totalCuFt * (1 + wastePct / 100);
  let bags = 0;
  if (!yieldCuFt) issues.push({ id: 'concrete-yield', severity: 'blocker', area: 'footings', message: 'Selected concrete product has no documented yield per bag in the catalog' });
  else bags = Math.ceil(withWaste / yieldCuFt - 1e-9);
  return {
    eachCuFt, totalCuFt, withWasteCuFt: withWaste, bags, issues,
    formula: `${formula} = ${r3(eachCuFt)} cu ft × ${count} = ${r3(totalCuFt)} cu ft; +${wastePct}% waste = ${r3(withWaste)} cu ft; ÷ ${yieldCuFt ?? '?'} cu ft/bag, rounded up = ${bags} bags`,
  };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
