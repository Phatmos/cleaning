/**
 * Shared data contracts between the engine, server and web client.
 * All lengths are INCHES. Angles are DEGREES, measured counter-clockwise from
 * the +x axis of the sketch (x to the right, y "up"/away from the house in plan).
 */

// ───────────────────────── Geometry ─────────────────────────

export interface Pt { x: number; y: number }

export type ShapeKind = 'rect' | 'triangle' | 'polygon' | 'arc';

export interface ShapeBase {
  id: string;
  label: string;
  /** Finished deck surface height above grade at this area, inches. */
  heightIn?: number;
}
/** Axis-aligned rectangle anchored at (x, y) = its lower-left corner. */
export interface RectShape extends ShapeBase { kind: 'rect'; x: number; y: number; w: number; h: number }
/** Triangle given by base on +x from (x,y), apex offset along base and perpendicular height. */
export interface TriangleShape extends ShapeBase { kind: 'triangle'; x: number; y: number; base: number; height: number; apexOffset: number; flip?: boolean }
export interface PolygonShape extends ShapeBase { kind: 'polygon'; points: Pt[] }
/**
 * Circular segment / curved bump-out: chord from p1 to p2, bulging by `sagitta`
 * (positive = to the left of p1→p2). Approximated by `segments` straight chords.
 */
export interface ArcShape extends ShapeBase { kind: 'arc'; p1: Pt; p2: Pt; sagitta: number; segments: number }

export type Shape = RectShape | TriangleShape | PolygonShape | ArcShape;

/** Edge classification. Key = `${shapeId}:${edgeIndex}` of the source shape's edge. */
export interface EdgeTag {
  side: 'house' | 'open';
  ledger?: boolean;
  rail?: boolean;
  fascia?: boolean;
  /** Optional skirting along this edge. */
  skirting?: boolean;
}

export interface Opening {
  id: string;
  kind: 'gate' | 'stair';
  edgeKey: string;
  /** Distance from the edge's start vertex to the near side of the opening. */
  offsetIn: number;
  widthIn: number;
  /** Stair id when kind = 'stair'. */
  stairId?: string;
  gateStyle?: string;
}

export interface Override {
  value: number;
  reason: string;
  by: string;
  at: string;
  role?: Role;
}

export interface GeometryInput {
  shapes: Shape[];
  cutouts: Shape[];
  edgeTags: Record<string, EdgeTag>;
  openings: Opening[];
  /** Direction the joists run. Default 90 (perpendicular to an x-axis house wall). */
  joistAngleDeg: number;
  /** Decking board run direction, deg. Perpendicular to joists = joistAngle + 90. */
  deckingAngleDeg: number;
  areaOverride?: Override;
  railLengthOverride?: Override;
}

// ───────────────────────── Structure ─────────────────────────

export type LedgerSubstrate =
  | 'unknown'
  | 'wood-rim-joist'
  | 'brick-veneer'
  | 'solid-masonry'
  | 'concrete-foundation'
  | 'siding-unknown-backing'
  | 'other';

export interface BeamInput {
  id: string;
  /** Distance from the deck's min extent ALONG the joist direction, inches. */
  offsetIn: number;
  size: string; // e.g. "2x10"
  plies: number;
  /** Post spacing chosen by the salesman (on-center). */
  postSpacingIn?: number;
  overhangIn?: number;
  /** Manual post count; when set it replaces the computed count with an audit record. */
  postCountOverride?: Override;
}

export interface StructureInput {
  attachment?: 'attached' | 'freestanding';
  ledger: {
    substrate: LedgerSubstrate;
    wallConstruction?: string;
    flashing?: 'needed' | 'existing-ok' | 'unknown';
    access?: string;
    notes?: string;
    /** A reviewed, documented detail allowing attachment to a non-standard substrate. */
    verifiedDetailRef?: string;
  };
  joist: {
    size?: string; // "2x8"
    speciesGrade?: string; // matches rule tables, e.g. "SYP #2"
    spacingIn?: number; // on-center
    cantileverIn?: number;
    rimPlies: number;
    lumberSku?: string;
  };
  beams: BeamInput[];
  designLoadPsf?: { live?: number; dead?: number; snow?: number };
  postSize?: string; // "6x6"
}

export interface FootingSpec {
  shape: 'round' | 'square';
  diameterIn?: number;
  widthIn?: number;
  depthIn?: number;
  /** Above-grade pier height when a formed pier extends above grade. */
  pierAboveGradeIn?: number;
  reinforcement?: string;
}

export interface FootingsInput {
  support: 'new-footings' | 'existing-footings' | 'on-grade-pad' | 'existing-concrete' | 'unknown';
  spec: FootingSpec;
  /** Count override (otherwise one footing per structural post). */
  countOverride?: Override;
  soilAssumption?: string;
  bearingAssumptionPsf?: number;
  accessNotes?: string;
  reuseInspection?: { inspectedBy: string; date: string; dimensionsKnown: boolean; approved: boolean; notes?: string };
  concreteSku?: string;
  wastePct: number;
  excavationDisposal?: boolean;
}

export interface StairInput {
  id: string;
  label: string;
  /** Vertical difference between the finished deck surface and the landing/grade. */
  totalRiseIn?: number;
  widthIn?: number;
  treadDepthIn?: number; // run per tread
  /** 'deck-top': deck surface is the top step (treads = risers − 1). 'flush': treads = risers. */
  topConvention: 'deck-top' | 'flush';
  availableRunIn?: number;
  stringerSku?: string;
  stringerSpacingIn?: number;
  landing?: { widthIn: number; depthIn: number; type: 'concrete-pad' | 'pavers' | 'gravel' | 'existing' };
  railsLeft: boolean;
  railsRight: boolean;
  riserBoards: boolean;
  lightsPerRiser?: number;
}

export interface DeckingInput {
  /** Board-width gap from the product spec unless overridden. */
  gapOverrideIn?: number;
  pattern: 'straight' | 'diagonal';
  pictureFrameCourses: 0 | 1 | 2 | 3;
  /** Kerf per cut. */
  kerfIn: number;
  /** Shortest offcut considered reusable. */
  minReusableIn: number;
  /** Extra waste percent applied to purchased quantity AFTER allocation (company policy). */
  extraWastePct: number;
  fasciaRows?: number;
}

export interface DemolitionInput {
  removeDecking: boolean;
  removeRails: boolean;
  removeFraming: boolean;
  removeFootings: boolean;
  retainedStructureCondition?: string;
  disposal: 'dumpster' | 'haul-away' | 'none' | 'unknown';
  accessConstraints?: string;
  narrowGateWidthIn?: number;
  staging?: string;
  turfProtection?: boolean;
  equipment?: string;
  permitRequired?: 'yes' | 'no' | 'unknown';
  hoaApproval?: 'yes' | 'no' | 'unknown';
  allowances: { id: string; label: string; amount: number }[];
  unknownConditions?: string;
}

// ───────────────────────── Consultation ─────────────────────────

export type MaterialKind = 'wood' | 'composite';

/** One priced alternative. Consultation selections create these. */
export interface Alternative {
  id: string;
  name: string;
  kind: MaterialKind;
  brand?: string;
  /** Catalog product group key for decking (brand|collection|color|profile). */
  deckingGroup?: string;
  fasciaGroup?: string;
  frameGroup?: string;
  railingSystem?: string;
  railingColor?: string;
  railingInfill?: string;
  packageId?: string;
  status: 'active' | 'needs-review' | 'removed';
  reviewReasons?: string[];
}

export interface ConsultationInput {
  projectType?: 'new' | 'replacement' | 'resurface' | 'repair';
  scopeNotes?: string;
  budget?: { min?: number; max?: number };
  materials: { wood: boolean; composite: boolean };
  wood: { species?: string; grade?: string; finish?: string };
  compositeBrands: string[];
  shape?: 'rectangle' | 'l-shape' | 'multi-area' | 'wraparound' | 'curved' | 'custom';
  deckingDirection?: 'perpendicular' | 'diagonal' | 'parallel-house';
  inspiration?: string;
  pictureFrame?: 'none' | 'single' | 'double' | 'custom';
  pictureFrameNotes?: string;
  fascia?: boolean;
  railing: { wanted?: boolean; style?: string; heightIn?: number };
  gates: { wanted?: boolean; notes?: string; count?: number };
  stairs: { wanted?: boolean; location?: string; approxWidthIn?: number; configuration?: string; landing?: string };
  extras: {
    skirting?: boolean;
    underDeck?: 'none' | 'drainage' | 'ceiling';
    lighting: { postCap?: boolean; stair?: boolean; riser?: boolean; accent?: boolean };
    postCaps?: boolean;
    concretePad?: boolean;
    coveredOrScreened?: boolean; // separately-scoped item, never auto-priced
    other?: string;
  };
  priorities?: string;
  alternativesRequested?: string;
  customerNotes?: string;
}

export interface PhotoRef {
  id: string;
  caption?: string;
  category?: 'existing-deck' | 'house-wall' | 'site' | 'access' | 'inspiration' | 'damage' | 'other';
  area?: string;
  status: 'queued' | 'uploading' | 'uploaded' | 'failed';
  url?: string;
  markupUrl?: string;
  takenAt: string;
}

export interface AiSuggestion {
  id: string;
  photoId: string;
  text: string;
  kind: 'question' | 'concern';
  status: 'unconfirmed' | 'confirmed' | 'dismissed';
  confirmedAnswer?: string;
}

/** The single document every estimate revision stores. */
export interface EstimateDoc {
  schemaVersion: 1;
  ui: { mode: 'consult' | 'technical' | 'review'; consultStep: number; techStep: number };
  consult: ConsultationInput;
  alternatives: Alternative[];
  geometry: GeometryInput;
  structure: StructureInput;
  footings: FootingsInput;
  decking: DeckingInput;
  stairs: StairInput[];
  demolition: DemolitionInput;
  /** Quantity overrides by BOM line key. */
  overrides: Record<string, Override>;
  photos: PhotoRef[];
  aiSuggestions: AiSuggestion[];
  internalNotes?: string;
  pricing: { discountPct?: number; discountAmount?: number; discountReason?: string; priceOverrides: Record<string, Override> };
  /** Manually added lines (catalog items such as joist tape, dumpsters, or a free-priced line). */
  customLines?: CustomLine[];
}

export type Role = 'admin' | 'manager' | 'salesman';

export interface CustomLine {
  id: string;
  /** Catalog item to price from; omit for a free-priced line (manager/admin only). */
  catalogId?: string;
  description: string;
  qty: number;
  unit: string;
  /** Sell price per unit for a free-priced line. */
  unitPrice?: number;
  unitCost?: number;
  /** Apply to these alternatives only (default: all). */
  alternativeIds?: string[];
  internalOnly?: boolean;
  reason: string;
  by?: string;
  at?: string;
}

/** Spec values an admin enters once per product line (not present in price books). */
export interface ProductSpecRule {
  id: string;
  match: { category?: string; brand?: string; collection?: string; profile?: string; skuPrefix?: string };
  set: { widthIn?: number; heightIn?: number; gapIn?: number; maxJoistSpacingIn?: number; perCrossing?: number; yieldCuFt?: number; maxSpanIn?: number; packQty?: number };
  source: string;
  enteredBy?: string;
}

/** Labor selection: names of labor items in the price book, with height/width tiers. */
export interface LaborMap {
  heightTiers: { maxIn: number | null; label: string }[];
  stairWidthBands: { maxIn: number; label: string }[];
  framing?: string;
  deckingComposite?: string;
  deckingWood?: string;
  pictureFrame?: string;
  fasciaComposite?: string;
  demo?: string;
  pier?: string;
  stairsComposite?: string;
  stairsWood?: string;
  railingBySystem: Record<string, string>;
  gate?: string;
  postCapLight?: string;
  stairLight?: string;
  transformer?: string;
  ledgerFlashing?: string;
  concretePad?: string;
}

export interface PricingPolicy {
  /** Markup applied on top of material + labor selling prices (overhead & profit). */
  projectMarkupPct: number;
  /** Commission, internal only: % of net selling price. */
  commissionPct: number;
  confirmed: boolean;
  note?: string;
}

// ───────────────────────── Catalog ─────────────────────────

export type Category =
  | 'decking' | 'fascia' | 'joist' | 'beam' | 'post' | 'ledger' | 'rim' | 'blocking'
  | 'hanger' | 'connector' | 'fastener' | 'flashing'
  | 'railing-section' | 'railing-post' | 'railing-accessory' | 'stair-rail' | 'gate'
  | 'stringer' | 'concrete' | 'footing-hardware' | 'lighting' | 'skirting' | 'labor' | 'demolition' | 'other';

export interface CatalogItem {
  id: string;
  sku: string;
  description: string;
  category: Category;
  brand?: string;
  collection?: string;
  color?: string;
  texture?: string;
  profile?: string;
  material?: 'wood' | 'composite' | 'pvc' | 'aluminum' | 'steel' | 'concrete' | 'other';
  /** Product group (all stock lengths of the same board share a group). */
  group?: string;
  thicknessIn?: number;
  widthIn?: number;
  heightIn?: number;
  stockLengthIn?: number;
  purchaseUnit: 'each' | 'lf' | 'sqft' | 'box' | 'bag' | 'pack' | 'kit' | 'roll' | 'pct';
  packQty?: number;
  /** Concrete yield per bag (cu ft), from the product's documentation. */
  yieldCuFt?: number;
  cost?: number;
  sale?: { method: 'markup' | 'margin' | 'fixed'; pct?: number; price?: number };
  labor?: { unit: string; rate: number };
  /** Price-book trade (DECKING, CARPENTRY, RAILING, …). */
  trade?: string;
  notes?: string;
  priceConfidence?: string;
  /** Allowance-type item (dumpster, delivery…) — added manually, never auto-quantified. */
  allowance?: boolean;
  /** Where spec values (width, gap, spans…) came from when merged from Product specs. */
  specSource?: string;
  spec?: {
    gapIn?: number;
    maxJoistSpacingIn?: number;
    /** Fasteners/clips per board-joist crossing. */
    perCrossing?: number;
    /** Railing: max on-center post span this section kit covers. */
    maxSpanIn?: number;
    railingSystem?: string;
    compatibleSystems?: string[];
    colors?: string[];
    /** Accessory needed per railing post (sleeve, cap, base), or per stair/gate. */
    per?: 'post' | 'section' | 'gate' | 'stair-side' | 'riser' | 'lf-ledger' | 'job';
    /** Railing posts: usable with any railing system of this brand (inferred). */
    compatibleBrand?: string;
    perQty?: number;
  };
  effectiveDate?: string;
  source?: string;
  isDemo?: boolean;
  active: boolean;
}

// ───────────────────────── Rules ─────────────────────────

export interface RuleSet {
  id: string;
  version: number;
  status: 'draft' | 'verified';
  jurisdiction: string;
  codeEdition: string;
  source: string;
  effectiveDate: string;
  reviewer?: string;
  reviewedAt?: string;
  joistSpans: { speciesGrade: string; size: string; spacingIn: number; maxSpanIn: number; maxCantileverIn?: number; liveLoadPsf?: number }[];
  beamSpans: { speciesGrade: string; size: string; plies: number; joistSpanIn: number; maxPostSpacingIn: number }[];
  stairs?: { maxRiserIn: number; minTreadIn: number; minWidthIn: number; maxStringerSpacingIn: number; guardRequiredAboveIn: number; handrailRequiredAtRisers: number };
  ledgerFastening?: { substrate: LedgerSubstrate; joistSpanUpToIn: number; fastener: string; spacingIn: number; rows: number; fastenerSku?: string }[];
  guardRequiredAboveIn?: number;
  notes?: string;
}

// ───────────────────────── Engine outputs ─────────────────────────

export type Severity = 'blocker' | 'review' | 'info';
export interface Issue {
  id: string;
  severity: Severity;
  area: 'geometry' | 'structure' | 'footings' | 'decking' | 'railing' | 'stairs' | 'pricing' | 'catalog' | 'consultation' | 'demolition';
  message: string;
  hint?: string;
}

export interface BomLine {
  key: string;
  group: 'Framing' | 'Footings' | 'Decking' | 'Fascia' | 'Railing' | 'Stairs' | 'Hardware' | 'Lighting' | 'Demolition' | 'Labor' | 'Allowances' | 'Other';
  description: string;
  sku?: string;
  catalogId?: string;
  unit: string;
  calcQty: number;
  purchaseQty: number;
  wastePct?: number;
  rounding?: string;
  formula: string;
  inputs: Record<string, number | string>;
  ruleRef?: string;
  sourceVersion?: string;
  override?: Override;
  effectiveQty: number;
  status: 'ok' | 'needs-product' | 'needs-pricing' | 'review';
  notes?: string;
  /** Cut list or allocation trace for traceability. */
  detail?: unknown;
}
