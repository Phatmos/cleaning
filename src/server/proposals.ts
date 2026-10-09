/**
 * Proposal snapshots, customer-safe projection, PDF and contract rendering.
 * A snapshot freezes the calculated result, catalog version and rule version at
 * creation, so later catalog/rule changes never alter a sent proposal.
 */
import PDFDocument from 'pdfkit';
import type { EstimateDoc } from '../shared/types';
import type { EstimateResult } from '../engine/estimate';

export interface PublicAlternative {
  id: string;
  name: string;
  kind: string;
  brand?: string;
  decking?: string;
  fascia?: string;
  railing?: string;
  scope: { group: string; items: { description: string; qty: number; unit: string }[] }[];
  allowances: { label: string; amount: number }[];
  price: { subtotal: number; discount: number; tax: number; total: number };
}
export interface PublicSnapshot {
  proposalVersion: number;
  createdAt: string;
  company: { name: string; phone?: string; email?: string; website?: string; license?: string };
  customer: { name: string; address?: string };
  project: { type?: string; areaSqFt: number; perimeterFt: number; rings: { hole: boolean; pts: { x: number; y: number }[] }[]; heightIn?: number; stairs: number; gates: number };
  selections: { label: string; value: string }[];
  alternatives: PublicAlternative[];
  recommendedAlternativeId?: string;
  exclusions: string[];
  terms: string;
  photos: { id: string; caption?: string }[];
  frozen: { engineVersion: string; catalogVersion: string; rulesVersion: string };
}
export interface InternalSnapshot { lines: Record<string, unknown[]>; totals: Record<string, unknown>; doc: EstimateDoc }

export function buildSnapshot(args: {
  version: number; doc: EstimateDoc; result: EstimateResult; altIds: string[]; recommended?: string;
  customer: { name: string; address?: string }; company: PublicSnapshot['company']; terms: string; exclusions: string[]; photoIds: { id: string; caption?: string }[];
  catalog: Map<string, { description: string; color?: string; collection?: string; brand?: string }>;
}): { pub: PublicSnapshot; internal: InternalSnapshot } {
  const { doc, result } = args;
  const c = doc.consult;
  const yes = (b?: boolean) => (b ? 'Yes' : 'No');
  const selections: PublicSnapshot['selections'] = [
    { label: 'Project type', value: c.projectType ? { new: 'New deck', replacement: 'Full replacement', resurface: 'Resurfacing', repair: 'Repair' }[c.projectType] : '—' },
    { label: 'Layout', value: c.shape ?? '—' },
    { label: 'Decking direction', value: doc.decking.pattern === 'diagonal' ? 'Diagonal' : c.deckingDirection ?? 'Standard' },
    { label: 'Picture frame border', value: doc.decking.pictureFrameCourses ? `${doc.decking.pictureFrameCourses} course(s)` : 'None' },
    { label: 'Fascia', value: yes(c.fascia) },
    { label: 'Railing', value: yes(c.railing.wanted) },
    { label: 'Gates', value: String(doc.geometry.openings.filter((o) => o.kind === 'gate').length) },
    { label: 'Stairs', value: String(doc.stairs.length) },
    { label: 'Lighting', value: Object.entries(c.extras.lighting).filter(([, v]) => v).map(([k]) => k).join(', ') || 'None' },
    { label: 'Under-deck', value: c.extras.underDeck ?? 'None' },
  ];
  const alts = result.alternatives.filter((a) => args.altIds.includes(a.alternative.id));
  const pubAlts: PublicAlternative[] = alts.map((a) => {
    const groups = new Map<string, { description: string; qty: number; unit: string }[]>();
    for (const l of a.lines) {
      if (l.kind === 'allowance' || l.effectiveQty === 0 || l.inputs?.internalOnly) continue;
      const g = l.group === 'Labor' ? 'Installation' : l.group;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push({ description: l.description.replace(/ — .*?\((\d+)'\)$/, ''), qty: l.effectiveQty, unit: l.unit });
    }
    const t = a.totals;
    const desc = (g?: string) => (g ? g.split('|').filter(Boolean).join(' · ') : undefined);
    return {
      id: a.alternative.id, name: a.alternative.name, kind: a.alternative.kind, brand: a.alternative.brand,
      decking: desc(a.alternative.deckingGroup), fascia: c.fascia ? desc(a.alternative.fasciaGroup) : undefined,
      railing: c.railing.wanted && a.alternative.railingSystem ? [a.alternative.railingSystem, a.alternative.railingColor, a.alternative.railingInfill].filter(Boolean).join(' · ') : undefined,
      scope: [...groups.entries()].map(([group, items]) => ({ group, items })),
      allowances: a.lines.filter((l) => l.kind === 'allowance').map((l) => ({ label: l.description, amount: l.extSell ?? 0 })),
      price: { subtotal: round2(t.subtotal), discount: round2(t.discount), tax: round2(t.tax ?? 0), total: round2(t.total ?? 0) },
    };
  });
  const pub: PublicSnapshot = {
    proposalVersion: args.version, createdAt: new Date().toISOString(), company: args.company, customer: args.customer,
    project: { type: c.projectType, areaSqFt: round2(result.area.effectiveSqFt), perimeterFt: round2(result.perimeterFt), rings: result.geometry.rings.map((r) => ({ hole: r.hole, pts: r.pts })), heightIn: Math.max(0, ...doc.geometry.shapes.map((s) => s.heightIn ?? 0)) || undefined, stairs: doc.stairs.length, gates: doc.geometry.openings.filter((o) => o.kind === 'gate').length },
    selections, alternatives: pubAlts, recommendedAlternativeId: args.recommended, exclusions: args.exclusions, terms: args.terms, photos: args.photoIds,
    frozen: { engineVersion: result.engineVersion, catalogVersion: result.catalogVersion, rulesVersion: result.rulesVersion },
  };
  const internal: InternalSnapshot = { lines: Object.fromEntries(alts.map((a) => [a.alternative.id, a.lines])), totals: Object.fromEntries(alts.map((a) => [a.alternative.id, a.totals])), doc };
  return { pub, internal };
}

const round2 = (x: number) => Math.round(x * 100) / 100;
export const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export function proposalPdf(s: PublicSnapshot): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'LETTER', margin: 54, info: { Title: `Deck proposal — ${s.customer.name}` } });
    const chunks: Buffer[] = [];
    pdf.on('data', (c) => chunks.push(c));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    pdf.fontSize(20).fillColor('#1d1d1f').text(s.company.name, { continued: false });
    pdf.fontSize(9).fillColor('#6e6e73').text([s.company.phone, s.company.email, s.company.website, s.company.license].filter(Boolean).join('   ·   '));
    pdf.moveDown(1.2);
    pdf.fontSize(14).fillColor('#1d1d1f').text(`Deck proposal for ${s.customer.name}`);
    pdf.fontSize(10).fillColor('#3a3a3c').text(s.customer.address ?? '');
    pdf.text(`Proposal v${s.proposalVersion} · ${new Date(s.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}`);
    pdf.moveDown();
    pdf.fontSize(11).fillColor('#1d1d1f').text(`Deck area ${s.project.areaSqFt} sq ft · perimeter ${s.project.perimeterFt} ft`);
    // sketch
    const pts = s.project.rings.flatMap((r) => r.pts);
    if (pts.length) {
      const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
      const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
      const W = 220, H = 140;
      const k = Math.min(W / (maxX - minX || 1), H / (maxY - minY || 1));
      const ox = pdf.x, oy = pdf.y + 6;
      pdf.save().lineWidth(1.2).strokeColor('#0a84ff');
      for (const r of s.project.rings) {
        r.pts.forEach((p, i) => {
          const X = ox + (p.x - minX) * k, Y = oy + H - (p.y - minY) * k;
          if (i === 0) pdf.moveTo(X, Y); else pdf.lineTo(X, Y);
        });
        pdf.closePath().stroke();
      }
      pdf.restore();
      pdf.y = oy + H + 12;
      pdf.x = 54;
    }
    for (const a of s.alternatives) {
      pdf.moveDown(0.6);
      pdf.fontSize(13).fillColor('#1d1d1f').text(`${a.name}${a.id === s.recommendedAlternativeId ? '  (recommended)' : ''}`);
      pdf.fontSize(9).fillColor('#3a3a3c').text([a.decking && `Decking: ${a.decking}`, a.fascia && `Fascia: ${a.fascia}`, a.railing && `Railing: ${a.railing}`].filter(Boolean).join('   ·   '));
      for (const g of a.scope) {
        pdf.fontSize(10).fillColor('#1d1d1f').text(g.group, { underline: false });
        pdf.fontSize(9).fillColor('#3a3a3c');
        for (const i of g.items) pdf.text(`•  ${i.description} — ${i.qty} ${i.unit}`, { indent: 10 });
      }
      for (const al of a.allowances) pdf.fontSize(9).text(`Allowance: ${al.label} — ${money(al.amount)}`);
      pdf.fontSize(10).fillColor('#1d1d1f').text(`Subtotal ${money(a.price.subtotal)}${a.price.discount ? `   Discount −${money(a.price.discount)}` : ''}   Tax ${money(a.price.tax)}`);
      pdf.fontSize(13).text(`Total ${money(a.price.total)}`);
    }
    if (s.exclusions.length) {
      pdf.moveDown().fontSize(11).text('Exclusions');
      pdf.fontSize(9).fillColor('#3a3a3c');
      for (const e of s.exclusions) pdf.text(`•  ${e}`);
    }
    if (s.terms) pdf.moveDown().fontSize(11).fillColor('#1d1d1f').text('Terms').fontSize(9).fillColor('#3a3a3c').text(s.terms);
    pdf.end();
  });
}

/** {{path.to.value}} placeholders; unknown values become visible [[MISSING: path]] markers. */
export function renderTemplate(body: string, data: Record<string, unknown>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, p: string) => {
    const v = p.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), data);
    if (v === undefined || v === null || v === '') {
      missing.push(p);
      return `[[MISSING: ${p}]]`;
    }
    return Array.isArray(v) ? v.join('\n') : String(v);
  });
  return { text, missing };
}

export const DEFAULT_CONTRACT_TEMPLATE = `{{company.name}} — CONSTRUCTION AGREEMENT

Customer: {{customer.name}}
Property address: {{customer.address}}
Proposal version: {{proposal.version}}  ·  Selected option: {{package.name}}

SCOPE OF WORK
{{scope}}

MATERIALS AND SELECTIONS
Decking: {{package.decking}}
Fascia: {{package.fascia}}
Railing: {{package.railing}}
Layout: {{project.area}} sq ft, perimeter {{project.perimeter}} ft
Selections:
{{selections}}

ALLOWANCES
{{allowances}}

EXCLUSIONS
{{exclusions}}

CUSTOMER NOTES
{{notes}}

CONTRACT PRICE
Total: {{price.total}}

PAYMENT TERMS
{{terms.payment}}

WARRANTY
{{terms.warranty}}

[ADMIN: Insert your attorney-approved contract terms here (cancellation rights, change orders, permits, liability, dispute resolution). This app does not supply legal terms.]

Customer signature: ______________________   Date: __________
{{company.name}} representative: ______________________   Date: __________
`;
