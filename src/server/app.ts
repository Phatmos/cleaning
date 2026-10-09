import express, { type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CatalogItem, EstimateDoc, LaborMap, Override, PricingPolicy, ProductSpecRule, Role, RuleSet } from '../shared/types';
import { calculate, isComplete, newEstimateDoc, reviewAlternatives, type CalcContext } from '../engine';
import { audit, type DB, getSetting, now, setSetting, tx } from './db';
import { authMiddleware, createSession, hashPassword, newToken, requireRole, requireUser, verifyPassword } from './auth';
import { parseUpload, suggestMapping, TARGET_FIELDS, templateCsv, validateBatch } from './catalogImport';
import { aiConfigured, analyzePhoto, integrationStatuses, smtpProvider, ZohoClient, zohoConfig, type EmailProvider } from './integrations';
import { buildSnapshot, DEFAULT_CONTRACT_TEMPLATE, money, proposalPdf, renderTemplate, type InternalSnapshot, type PublicSnapshot } from './proposals';

export interface AppDeps { db: DB; dataDir: string; email?: EmailProvider; zoho?: ZohoClient; publicBaseUrl?: string }

const id = (p: string) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
const J = <T>(s: string | null | undefined, d: T): T => (s ? (JSON.parse(s) as T) : d);
class HttpError extends Error { constructor(public status: number, message: string, public body?: Record<string, unknown>) { super(message); } }
const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response, next: NextFunction) => Promise.resolve(fn(req, res)).catch(next);

export const DEFAULT_SETTINGS = {
  company: { name: 'Yellowstone Renovation', phone: '', email: '', website: '', license: '' },
  tax: { configured: false, ratePct: undefined as number | undefined, base: 'none', note: 'Kentucky sales-tax treatment for this contract type must be verified and entered by an admin.' },
  discounts: { salesmanMaxPct: 0, managerMaxPct: 15 },
  brands: { composite: ['Trex', 'TimberTech', 'Deckorators'], woodSpecies: [] as string[] },
  productSpecs: [] as ProductSpecRule[],
  pricingPolicy: { projectMarkupPct: 0, commissionPct: 0, confirmed: false, note: 'Developer handoff mentions 25% markup and 10% commission as historical assumptions — confirm before enabling.' } as PricingPolicy,
  /** Item NAMES from the Yellowstone Leap labor price book. {tier} {size} {spacing} {width} {n} are filled from the estimate. */
  laborMap: {
    heightTiers: [{ maxIn: 72, label: 'Up to 6 ft' }, { maxIn: 216, label: '7-18 ft' }, { maxIn: null, label: '19 ft Plus' }],
    stairWidthBands: [{ maxIn: 60, label: '4-5 ft Wide' }, { maxIn: 72, label: '6 ft Wide' }, { maxIn: 96, label: '8 ft Wide' }, { maxIn: 120, label: '10 ft Wide' }, { maxIn: 144, label: '12 ft Wide' }],
    framing: 'Structural Deck Frame - {tier} - {size} @ {spacing} in OC',
    deckingComposite: 'Install Composite/PVC Decking + Joist Tape - {tier}',
    deckingWood: 'Install PT/Cedar Decking - {tier}',
    pictureFrame: 'Picture Frame + Joist Tape - {tier}',
    fasciaComposite: 'Install Composite/PVC Fascia - {tier}',
    demo: 'Demo Deck Frame & Floor - {tier}',
    pier: 'Install Concrete Pier',
    stairsComposite: 'Composite Closed-End Stairs - {width}',
    stairsWood: 'PT/Cedar Stairs - {width}',
    railingBySystem: { 'Trex Signature Aluminum': 'Install Aluminum/Steel Railing', 'Deckorators ALX Contemporary': 'Install Aluminum/Steel Railing' },
    gate: 'Aluminum/Steel Railing Gate 4-6 ft',
    postCapLight: 'Install Post Cap Light',
    stairLight: 'Install Recessed/Surface Deck Light',
    transformer: 'Install Transformer & Lighting Connections',
    ledgerFlashing: 'Cut Back Siding & Install Z-Bar Flashing',
    concretePad: 'Pour {n}x{n} Concrete Pad',
  } as LaborMap,
  proposal: { terms: '', exclusions: [] as string[], validDays: 30 },
  contractTerms: { payment: '', warranty: '' },
  zohoStages: {
    pipeline: 'Yellowstone Renovation Sales',
    onsiteScheduled: 'Appointment Scheduled', onsiteCompleted: 'Estimate in Progress', estimateSent: 'Estimate Sent',
    followUp: 'Follow Up', approved: '', contractSigned: 'Contract Signed', handoff: '',
    confirmed: false,
    note: 'Stage names read from the Zoho Deals "Stage" picklist on 2026-10-09. Confirm which belong to the Yellowstone Renovation Sales pipeline before enabling stage sync.',
  },
  followups: { enabled: false, dayZero: 'send-date', timezone: 'America/New_York', cadenceDays: [1, 3, 7, 14], resendRestartsFollowups: false, ownerEligibility: 'deal-owner', canonicalTrigger: 'app-send', stopOn: ['approved', 'contract-signed', 'closed', 'manual-hold'] },
};

export function createApp(deps: AppDeps) {
  const { db, dataDir } = deps;
  const email = deps.email ?? smtpProvider();
  const zoho = deps.zoho ?? new ZohoClient(zohoConfig());
  const uploadDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));
  app.use(authMiddleware(db));

  const setting = <K extends keyof typeof DEFAULT_SETTINGS>(k: K) => getSetting(db, k, DEFAULT_SETTINGS[k]);
  const catalogVersion = () => {
    const r = db.prepare('SELECT MAX(id) v FROM catalog_versions').get() as { v: number | null };
    return `cat-${r.v ?? 0}`;
  };
  const loadCatalog = (): CatalogItem[] => {
    const rules = setting('productSpecs');
    return (db.prepare('SELECT id, data, active, is_demo FROM catalog_items').all() as any[]).map((r) => applySpecs({ ...JSON.parse(r.data), id: r.id, active: !!r.active, isDemo: !!r.is_demo }, rules));
  };
  const activeRules = (): RuleSet | null => {
    const r = db.prepare('SELECT data FROM rule_sets WHERE active = 1 ORDER BY version DESC LIMIT 1').get() as { data: string } | undefined;
    return r ? JSON.parse(r.data) : null;
  };
  const calcCtx = (): CalcContext => {
    const tax = setting('tax');
    return { catalog: loadCatalog(), catalogVersion: catalogVersion(), rules: activeRules(), tax: { configured: !!tax.configured, ratePct: tax.ratePct, base: tax.base as any }, laborMap: setting('laborMap'), policy: setting('pricingPolicy') };
  };

  const getEstimate = (req: Request, estId: string) => {
    const e = db.prepare('SELECT * FROM estimates WHERE id = ?').get(estId) as any;
    if (!e) throw new HttpError(404, 'Estimate not found');
    if (req.user!.role === 'salesman' && e.salesman_id !== req.user!.id) throw new HttpError(403, 'This estimate is assigned to another salesman');
    return e;
  };
  const canSeeCustomer = (req: Request, customerId: string) => {
    if (req.user!.role !== 'salesman') return true;
    const u = req.user!.id;
    return !!db.prepare(`SELECT 1 FROM customers c WHERE c.id = ? AND (
      EXISTS (SELECT 1 FROM appointments a WHERE a.customer_id = c.id AND a.salesman_id = ?)
      OR EXISTS (SELECT 1 FROM estimates e WHERE e.customer_id = c.id AND e.salesman_id = ?)
      OR EXISTS (SELECT 1 FROM deals d WHERE d.customer_id = c.id AND d.owner_id = ?))`).get(customerId, u, u, u);
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true, version: process.env.RENDER_GIT_COMMIT ?? process.env.COMMIT_SHA ?? 'dev' }));

  // ───────────── Auth ─────────────
  app.post('/api/auth/login', wrap((req, res) => {
    const { email: em, password } = req.body ?? {};
    const u = db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) AND active = 1').get(String(em ?? '')) as any;
    if (!u || !verifyPassword(String(password ?? ''), u.password_hash)) throw new HttpError(401, 'Email or password is incorrect');
    const token = createSession(db, u.id);
    audit(db, u.id, 'login', 'user', u.id);
    res.json({ token, user: { id: u.id, email: u.email, name: u.name, role: u.role } });
  }));
  app.post('/api/auth/logout', requireUser, wrap((req, res) => {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.headers.authorization!.slice(7));
    res.json({ ok: true });
  }));
  app.get('/api/me', requireUser, (req, res) => res.json({ user: req.user }));

  app.get('/api/users', requireRole('admin', 'manager'), (_req, res) => res.json(db.prepare('SELECT id, email, name, role, active, zoho_user_id FROM users ORDER BY name').all()));
  app.post('/api/users', requireRole('admin'), wrap((req, res) => {
    const { email: em, name, role, password } = req.body ?? {};
    if (!em || !name || !['admin', 'manager', 'salesman'].includes(role) || !password || String(password).length < 8) throw new HttpError(400, 'email, name, role and a password of 8+ characters are required');
    const uid = id('usr');
    db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)').run(uid, em, name, role, hashPassword(password), now());
    audit(db, req.user!.id, 'create', 'user', uid, { email: em, role });
    res.status(201).json({ id: uid });
  }));

  // ───────────── Settings ─────────────
  app.get('/api/settings', requireUser, (req, res) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) out[k] = setting(k);
    res.json(out);
  });
  app.put('/api/settings/:key', requireRole('admin'), wrap((req, res) => {
    if (!(req.params.key in DEFAULT_SETTINGS)) throw new HttpError(404, 'Unknown setting');
    setSetting(db, req.params.key, req.body, req.user!.id);
    audit(db, req.user!.id, 'update', 'setting', req.params.key, req.body);
    res.json({ ok: true });
  }));
  app.get('/api/integrations', requireUser, (_req, res) => res.json(integrationStatuses()));

  // ───────────── Customers & visits ─────────────
  app.get('/api/customers', requireUser, (req, res) => {
    const q = `%${String(req.query.q ?? '').toLowerCase()}%`;
    const rows = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM estimates e WHERE e.customer_id = c.id) estimate_count,
      (SELECT MIN(a.starts_at) FROM appointments a WHERE a.customer_id = c.id AND a.starts_at >= ?) next_visit
      FROM customers c WHERE lower(c.name || ' ' || coalesce(c.address,'') || ' ' || coalesce(c.email,'') || ' ' || coalesce(c.phone,'')) LIKE ? ORDER BY c.updated_at DESC LIMIT 200`).all(new Date(Date.now() - 12 * 3600e3).toISOString(), q) as any[];
    res.json(rows.filter((c) => canSeeCustomer(req, c.id)));
  });
  app.post('/api/customers', requireUser, wrap((req, res) => {
    const b = req.body ?? {};
    if (!b.name) throw new HttpError(400, 'Customer name is required');
    if (b.zohoContactId) {
      const ex = db.prepare('SELECT id FROM customers WHERE zoho_contact_id = ?').get(b.zohoContactId) as any;
      if (ex) return res.status(200).json({ id: ex.id, existing: true });
    }
    const cid = id('cus');
    db.prepare('INSERT INTO customers (id, name, email, phone, address, city, state, zip, zoho_contact_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(cid, b.name, b.email ?? null, b.phone ?? null, b.address ?? null, b.city ?? null, b.state ?? 'KY', b.zip ?? null, b.zohoContactId ?? null, now(), now());
    audit(db, req.user!.id, 'create', 'customer', cid);
    res.status(201).json({ id: cid });
  }));
  app.get('/api/customers/:id', requireUser, wrap((req, res) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id) as any;
    if (!c) throw new HttpError(404, 'Customer not found');
    if (!canSeeCustomer(req, c.id)) throw new HttpError(403, 'Not assigned to you');
    const estimates = (db.prepare(`SELECT e.*, u.name salesman_name, r.number rev_number, r.updated_at rev_updated, r.locked rev_locked,
      (SELECT COUNT(*) FROM estimate_revisions x WHERE x.estimate_id = e.id) revision_count,
      (SELECT MAX(version) FROM proposals p WHERE p.estimate_id = e.id) proposal_version
      FROM estimates e LEFT JOIN users u ON u.id = e.salesman_id LEFT JOIN estimate_revisions r ON r.id = e.current_revision_id WHERE e.customer_id = ? ORDER BY e.updated_at DESC`).all(c.id) as any[])
      .filter((e) => req.user!.role !== 'salesman' || e.salesman_id === req.user!.id);
    res.json({
      customer: c,
      deals: db.prepare('SELECT * FROM deals WHERE customer_id = ?').all(c.id),
      appointments: db.prepare('SELECT a.*, u.name salesman_name FROM appointments a LEFT JOIN users u ON u.id = a.salesman_id WHERE a.customer_id = ? ORDER BY a.starts_at DESC').all(c.id),
      estimates,
    });
  }));
  app.patch('/api/customers/:id', requireUser, wrap((req, res) => {
    if (!canSeeCustomer(req, req.params.id)) throw new HttpError(403, 'Not assigned to you');
    const allowed = ['name', 'email', 'phone', 'address', 'city', 'state', 'zip'];
    const sets = Object.keys(req.body ?? {}).filter((k) => allowed.includes(k));
    if (!sets.length) return res.json({ ok: true });
    db.prepare(`UPDATE customers SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...sets.map((k) => req.body[k]), now(), req.params.id);
    audit(db, req.user!.id, 'update', 'customer', req.params.id, req.body);
    res.json({ ok: true });
  }));

  app.get('/api/visits', requireUser, (req, res) => {
    const from = String(req.query.from ?? new Date(Date.now() - 24 * 3600e3).toISOString());
    const to = String(req.query.to ?? new Date(Date.now() + 14 * 24 * 3600e3).toISOString());
    const mine = req.user!.role === 'salesman' || req.query.mine === '1';
    const rows = db.prepare(`SELECT a.*, c.name customer_name, c.phone customer_phone, c.address customer_address, u.name salesman_name, d.zoho_deal_id, d.stage,
      (SELECT e.id FROM estimates e WHERE e.appointment_id = a.id ORDER BY e.created_at LIMIT 1) estimate_id
      FROM appointments a JOIN customers c ON c.id = a.customer_id LEFT JOIN users u ON u.id = a.salesman_id LEFT JOIN deals d ON d.id = a.deal_id
      WHERE a.starts_at BETWEEN ? AND ? ${mine ? 'AND a.salesman_id = ?' : ''} ORDER BY a.starts_at`).all(...(mine ? [from, to, req.user!.id] : [from, to]));
    res.json(rows);
  });
  app.post('/api/appointments', requireRole('admin', 'manager'), wrap((req, res) => {
    const b = req.body ?? {};
    if (!b.customerId || !b.startsAt || !b.salesmanId) throw new HttpError(400, 'customerId, salesmanId and startsAt are required');
    const aid = id('apt');
    db.prepare('INSERT INTO appointments (id, customer_id, deal_id, salesman_id, starts_at, ends_at, address, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(aid, b.customerId, b.dealId ?? null, b.salesmanId, b.startsAt, b.endsAt ?? null, b.address ?? null, b.notes ?? null, now());
    audit(db, req.user!.id, 'create', 'appointment', aid);
    res.status(201).json({ id: aid });
  }));

  // ───────────── Estimates ─────────────
  const createEstimate = (userId: string, b: { customerId: string; title?: string; appointmentId?: string; dealId?: string; salesmanId?: string; doc?: EstimateDoc; propertyAddress?: string }) => {
    const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(b.customerId) as any;
    if (!c) throw new HttpError(404, 'Customer not found');
    const eid = id('est');
    const rid = id('rev');
    const t = now();
    tx(db, () => {
      db.prepare('INSERT INTO estimates (id, customer_id, deal_id, appointment_id, salesman_id, title, property_address, status, current_revision_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(eid, c.id, b.dealId ?? null, b.appointmentId ?? null, b.salesmanId ?? userId, b.title || 'Deck estimate', b.propertyAddress ?? [c.address, c.city, c.state, c.zip].filter(Boolean).join(', '), 'draft', rid, t, t);
      db.prepare('INSERT INTO estimate_revisions (id, estimate_id, number, doc, version, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?)').run(rid, eid, 1, JSON.stringify(b.doc ?? newEstimateDoc()), 1, t, t, userId);
    });
    audit(db, userId, 'create', 'estimate', eid, { customerId: c.id, appointmentId: b.appointmentId });
    return eid;
  };
  app.post('/api/estimates', requireUser, wrap((req, res) => {
    const b = req.body ?? {};
    if (!canSeeCustomer(req, b.customerId)) throw new HttpError(403, 'Not assigned to you');
    res.status(201).json({ id: createEstimate(req.user!.id, { ...b, salesmanId: req.user!.role === 'salesman' ? req.user!.id : b.salesmanId }) });
  }));
  app.post('/api/appointments/:id/estimate', requireUser, wrap((req, res) => {
    const a = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id) as any;
    if (!a) throw new HttpError(404, 'Appointment not found');
    if (req.user!.role === 'salesman' && a.salesman_id !== req.user!.id) throw new HttpError(403, 'Visit assigned to another salesman');
    const ex = db.prepare('SELECT id FROM estimates WHERE appointment_id = ? ORDER BY created_at LIMIT 1').get(a.id) as any;
    if (ex) return res.json({ id: ex.id, existing: true });
    res.status(201).json({ id: createEstimate(req.user!.id, { customerId: a.customer_id, appointmentId: a.id, dealId: a.deal_id, salesmanId: a.salesman_id, propertyAddress: a.address ?? undefined }) });
  }));
  app.get('/api/estimates/:id', requireUser, wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    const revisions = db.prepare('SELECT id, number, version, locked, locked_reason, label, parent_revision_id, created_at, updated_at, updated_by FROM estimate_revisions WHERE estimate_id = ? ORDER BY number').all(e.id);
    const cur = db.prepare('SELECT * FROM estimate_revisions WHERE id = ?').get(e.current_revision_id) as any;
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(e.customer_id);
    const proposals = db.prepare('SELECT id, revision_id, version, token, status, created_at, sent_at, approved_at, approved_name, approved_alternative, view_count FROM proposals WHERE estimate_id = ? ORDER BY version').all(e.id);
    const deliveries = db.prepare('SELECT d.* FROM deliveries d JOIN proposals p ON p.id = d.proposal_id WHERE p.estimate_id = ? ORDER BY d.created_at').all(e.id);
    const contracts = db.prepare('SELECT id, proposal_id, status, created_at, signed_at FROM contracts WHERE estimate_id = ?').all(e.id);
    const photos = db.prepare('SELECT id, client_id, caption, category, area, original_name, created_at, markup_path IS NOT NULL has_markup FROM photos WHERE estimate_id = ? ORDER BY created_at').all(e.id);
    const ai = db.prepare('SELECT * FROM ai_suggestions WHERE estimate_id = ? ORDER BY created_at').all(e.id);
    const appointment = e.appointment_id ? db.prepare('SELECT * FROM appointments WHERE id = ?').get(e.appointment_id) : null;
    const deal = e.deal_id ? db.prepare('SELECT * FROM deals WHERE id = ?').get(e.deal_id) : null;
    res.json({ estimate: e, customer, appointment, deal, revisions, current: { ...cur, doc: JSON.parse(cur.doc) }, proposals, deliveries, contracts, photos, aiSuggestions: ai });
  }));
  app.get('/api/estimates/:id/revisions/:rid', requireUser, wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    const r = db.prepare('SELECT * FROM estimate_revisions WHERE id = ? AND estimate_id = ?').get(req.params.rid, e.id) as any;
    if (!r) throw new HttpError(404, 'Revision not found');
    res.json({ ...r, doc: JSON.parse(r.doc) });
  }));

  /** Validate and stamp overrides/price changes by role. */
  const checkOverrides = (role: Role, user: { id: string; name: string }, prev: EstimateDoc, next: EstimateDoc) => {
    const changes: { path: string; before?: Override; after?: Override }[] = [];
    const stamp = (path: string, before: Override | undefined, after: Override | undefined): Override | undefined => {
      if (!after) {
        if (before) changes.push({ path, before });
        return undefined;
      }
      const same = before && before.value === after.value && before.reason === after.reason;
      if (same) return before;
      if (!after.reason || !after.reason.trim()) throw new HttpError(422, `Override "${path}" needs a reason`);
      if (!Number.isFinite(after.value) || after.value < 0) throw new HttpError(422, `Override "${path}" must be a non-negative number`);
      const s: Override = { value: after.value, reason: after.reason.trim(), by: user.name, at: now(), role };
      changes.push({ path, before, after: s });
      return s;
    };
    for (const k of new Set([...Object.keys(prev.overrides ?? {}), ...Object.keys(next.overrides ?? {})])) {
      const v = stamp(`qty:${k}`, prev.overrides?.[k], next.overrides?.[k]);
      if (v) next.overrides[k] = v; else delete next.overrides[k];
    }
    next.geometry.areaOverride = stamp('area', prev.geometry.areaOverride, next.geometry.areaOverride);
    next.geometry.railLengthOverride = stamp('railLength', prev.geometry.railLengthOverride, next.geometry.railLengthOverride);
    next.footings.countOverride = stamp('footingCount', prev.footings.countOverride, next.footings.countOverride);
    for (const b of next.structure.beams) b.postCountOverride = stamp(`posts:${b.id}`, prev.structure.beams.find((x) => x.id === b.id)?.postCountOverride, b.postCountOverride);
    const pp = prev.pricing ?? { priceOverrides: {} };
    const np = next.pricing ?? { priceOverrides: {} };
    next.pricing = np;
    np.priceOverrides ??= {};
    const priceKeys = new Set([...Object.keys(pp.priceOverrides ?? {}), ...Object.keys(np.priceOverrides)]);
    for (const k of priceKeys) {
      const before = pp.priceOverrides?.[k];
      const after = np.priceOverrides[k];
      const changed = JSON.stringify(before?.value) !== JSON.stringify(after?.value) || before?.reason !== after?.reason;
      if (changed && role === 'salesman') throw new HttpError(403, 'Only a manager or admin can override prices');
      const v = stamp(`price:${k}`, before, after);
      if (v) np.priceOverrides[k] = v; else delete np.priceOverrides[k];
    }
    const freeBefore = new Map((prev.customLines ?? []).filter((l) => !l.catalogId).map((l) => [l.id, JSON.stringify([l.unitPrice, l.unitCost, l.qty])]));
    for (const l of next.customLines ?? []) {
      if (!l.reason?.trim()) throw new HttpError(422, `Custom line "${l.description}" needs a reason`);
      if (!l.catalogId && freeBefore.get(l.id) !== JSON.stringify([l.unitPrice, l.unitCost, l.qty]) && role === 'salesman') throw new HttpError(403, 'Only a manager or admin can add a free-priced line — pick a price-book item instead');
      if (!l.by) { l.by = user.name; l.at = now(); }
    }
    if ((np.discountPct ?? 0) !== (pp.discountPct ?? 0) || (np.discountAmount ?? 0) !== (pp.discountAmount ?? 0)) {
      const lim = setting('discounts');
      const max = role === 'salesman' ? lim.salesmanMaxPct : role === 'manager' ? lim.managerMaxPct : 100;
      if ((np.discountPct ?? 0) > max) throw new HttpError(403, `Discount above ${max}% requires a higher role`);
      if (role === 'salesman' && (np.discountAmount ?? 0) > 0 && lim.salesmanMaxPct === 0) throw new HttpError(403, 'Salesmen cannot apply discounts');
      if (!np.discountReason?.trim() && ((np.discountPct ?? 0) > 0 || (np.discountAmount ?? 0) > 0)) throw new HttpError(422, 'Discount needs a reason');
      changes.push({ path: 'discount' });
    }
    return changes;
  };

  app.put('/api/estimates/:id/revisions/:rid', requireUser, wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    const { doc, baseVersion } = req.body ?? {};
    if (!doc || doc.schemaVersion !== 1 || typeof baseVersion !== 'number') throw new HttpError(400, 'doc (schemaVersion 1) and baseVersion are required');
    const result = tx(db, () => {
      const r = db.prepare('SELECT * FROM estimate_revisions WHERE id = ? AND estimate_id = ?').get(req.params.rid, e.id) as any;
      if (!r) throw new HttpError(404, 'Revision not found');
      if (r.locked) throw new HttpError(409, 'This revision is locked because it was sent — create a new revision to change it', { code: 'locked', reason: r.locked_reason });
      if (r.version !== baseVersion) {
        throw new HttpError(409, 'Saved on another device since you opened it', { code: 'conflict', server: { doc: JSON.parse(r.doc), version: r.version, updatedBy: r.updated_by, updatedAt: r.updated_at } });
      }
      const prev = JSON.parse(r.doc) as EstimateDoc;
      const changes = checkOverrides(req.user!.role, req.user!, prev, doc);
      // Upstream change impact: flag (never delete) invalid alternatives.
      doc.alternatives = reviewAlternatives(doc, loadCatalog());
      const t = now();
      db.prepare('UPDATE estimate_revisions SET doc = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(JSON.stringify(doc), t, req.user!.name, r.id);
      db.prepare('UPDATE estimates SET updated_at = ? WHERE id = ?').run(t, e.id);
      for (const c of changes) audit(db, req.user!.id, 'override', 'estimate', e.id, { revision: r.number, ...c });
      return { version: r.version + 1, updatedAt: t, doc };
    });
    res.json(result);
  }));
  app.post('/api/estimates/:id/revisions', requireUser, wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    const from = db.prepare('SELECT * FROM estimate_revisions WHERE id = ? AND estimate_id = ?').get(req.body?.fromRevisionId ?? e.current_revision_id, e.id) as any;
    if (!from) throw new HttpError(404, 'Source revision not found');
    const max = (db.prepare('SELECT MAX(number) n FROM estimate_revisions WHERE estimate_id = ?').get(e.id) as any).n as number;
    const rid = id('rev');
    const t = now();
    tx(db, () => {
      db.prepare('INSERT INTO estimate_revisions (id, estimate_id, number, doc, version, parent_revision_id, label, created_at, updated_at, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)').run(rid, e.id, max + 1, from.doc, 1, from.id, req.body?.label ?? null, t, t, req.user!.name);
      db.prepare('UPDATE estimates SET current_revision_id = ?, updated_at = ? WHERE id = ?').run(rid, t, e.id);
    });
    audit(db, req.user!.id, 'revise', 'estimate', e.id, { from: from.number, to: max + 1 });
    res.status(201).json({ id: rid, number: max + 1 });
  }));
  app.post('/api/estimates/:id/duplicate', requireUser, wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    const cur = db.prepare('SELECT doc FROM estimate_revisions WHERE id = ?').get(e.current_revision_id) as any;
    const nid = createEstimate(req.user!.id, { customerId: e.customer_id, appointmentId: e.appointment_id ?? undefined, dealId: e.deal_id ?? undefined, salesmanId: e.salesman_id, title: req.body?.title ?? `${e.title} (copy)`, doc: JSON.parse(cur.doc), propertyAddress: e.property_address });
    res.status(201).json({ id: nid });
  }));
  app.post('/api/estimates/:id/calculate', requireUser, wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    const r = db.prepare('SELECT doc FROM estimate_revisions WHERE id = ?').get(req.body?.revisionId ?? e.current_revision_id) as any;
    res.json(calculate(req.body?.doc ?? JSON.parse(r.doc), calcCtx()));
  }));
  app.get('/api/estimates/:id/activity', requireUser, wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    res.json(db.prepare('SELECT a.*, u.name user_name FROM audit a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity_id = ? OR a.entity_id IN (SELECT id FROM proposals WHERE estimate_id = ?) ORDER BY a.id DESC LIMIT 300').all(e.id, e.id));
  }));

  // ───────────── Catalog, assets, rules, packages ─────────────
  app.get('/api/catalog', requireUser, (_req, res) => res.json({ version: catalogVersion(), items: loadCatalog() }));
  const bumpCatalog = (by: string, note: string) => db.prepare('INSERT INTO catalog_versions (created_at, note, by) VALUES (?,?,?)').run(now(), note, by);
  app.post('/api/catalog/items', requireRole('admin'), wrap((req, res) => {
    const it = req.body as CatalogItem;
    if (!it?.sku || !it.description || !it.category) throw new HttpError(400, 'sku, description and category are required');
    const cid = id('cat');
    db.prepare('INSERT INTO catalog_items (id, sku, data, active, is_demo, updated_at) VALUES (?,?,?,?,0,?)').run(cid, it.sku, JSON.stringify({ ...it, id: cid }), it.active === false ? 0 : 1, now());
    bumpCatalog(req.user!.id, `add ${it.sku}`);
    audit(db, req.user!.id, 'create', 'catalog_item', cid, { sku: it.sku });
    res.status(201).json({ id: cid });
  }));
  app.patch('/api/catalog/items/:id', requireRole('admin'), wrap((req, res) => {
    const row = db.prepare('SELECT * FROM catalog_items WHERE id = ?').get(req.params.id) as any;
    if (!row) throw new HttpError(404, 'Item not found');
    const merged = { ...JSON.parse(row.data), ...req.body, id: row.id };
    db.prepare('UPDATE catalog_items SET data = ?, sku = ?, active = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(merged), merged.sku, merged.active === false ? 0 : 1, now(), row.id);
    bumpCatalog(req.user!.id, `edit ${merged.sku}`);
    audit(db, req.user!.id, 'update', 'catalog_item', row.id, req.body);
    res.json({ ok: true });
  }));
  app.get('/api/catalog/import-template.csv', requireRole('admin'), (_req, res) => res.type('text/csv').attachment('price-list-template.csv').send(templateCsv()));
  app.get('/api/catalog/fields', requireRole('admin'), (_req, res) => res.json(TARGET_FIELDS));
  app.get('/api/catalog/imports', requireRole('admin'), (_req, res) => res.json(db.prepare('SELECT id, filename, created_at, status, approved_at, report FROM import_batches ORDER BY created_at DESC').all().map((r: any) => ({ ...r, counts: J<any>(r.report, null)?.counts, report: undefined }))));
  app.post('/api/catalog/imports', requireRole('admin'), upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach a .csv or .xlsx price list');
    let parsed;
    try { parsed = await parseUpload(req.file.originalname, req.file.buffer); } catch (err) { throw new HttpError(400, (err as Error).message); }
    const bid = id('imp');
    const mapping = suggestMapping(parsed.headers);
    db.prepare('INSERT INTO import_batches (id, filename, uploaded_by, created_at, status, headers, rows, mapping) VALUES (?,?,?,?,?,?,?,?)').run(bid, req.file.originalname, req.user!.id, now(), 'mapping', JSON.stringify(parsed.headers), JSON.stringify(parsed.rows), JSON.stringify(mapping));
    audit(db, req.user!.id, 'upload', 'import_batch', bid, { filename: req.file.originalname, rows: parsed.rows.length });
    res.status(201).json({ id: bid, headers: parsed.headers, preview: parsed.rows.slice(0, 20), rowCount: parsed.rows.length, mapping, sheet: parsed.sheet });
  }));
  app.get('/api/catalog/imports/:id', requireRole('admin'), wrap((req, res) => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(req.params.id) as any;
    if (!b) throw new HttpError(404, 'Import not found');
    const rows = JSON.parse(b.rows);
    res.json({ ...b, headers: JSON.parse(b.headers), rows: undefined, preview: rows.slice(0, 20), rowCount: rows.length, mapping: J(b.mapping, {}), report: J(b.report, null) });
  }));
  app.put('/api/catalog/imports/:id/mapping', requireRole('admin'), wrap((req, res) => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(req.params.id) as any;
    if (!b) throw new HttpError(404, 'Import not found');
    if (b.status === 'approved') throw new HttpError(409, 'Already approved');
    const existing = new Set((db.prepare('SELECT sku FROM catalog_items').all() as any[]).map((r) => r.sku));
    const report = validateBatch(JSON.parse(b.headers), JSON.parse(b.rows), req.body.mapping ?? {}, existing, b.filename);
    db.prepare('UPDATE import_batches SET mapping = ?, report = ?, status = ? WHERE id = ?').run(JSON.stringify(req.body.mapping ?? {}), JSON.stringify(report), 'validated', b.id);
    res.json(report);
  }));
  app.post('/api/catalog/imports/:id/approve', requireRole('admin'), wrap((req, res) => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(req.params.id) as any;
    if (!b || b.status !== 'validated') throw new HttpError(409, 'Validate the mapping before approving');
    const report = JSON.parse(b.report) as ReturnType<typeof validateBatch>;
    const n = tx(db, () => {
      let count = 0;
      const prior: Record<string, { data: string; active: number; is_demo: number } | null> = {};
      for (const r of report.rows) {
        if (!r.item) continue;
        const ex = db.prepare('SELECT id, data, active, is_demo FROM catalog_items WHERE sku = ?').get(r.item.sku) as any;
        prior[r.item.sku] = ex ? { data: ex.data, active: ex.active, is_demo: ex.is_demo } : null;
        const cid = ex?.id ?? id('cat');
        const data = JSON.stringify({ ...r.item, id: cid });
        if (ex) db.prepare('UPDATE catalog_items SET data = ?, active = 1, is_demo = 0, import_batch_id = ?, updated_at = ? WHERE id = ?').run(data, b.id, now(), cid);
        else db.prepare('INSERT INTO catalog_items (id, sku, data, active, is_demo, import_batch_id, updated_at) VALUES (?,?,?,1,0,?,?)').run(cid, r.item.sku, data, b.id, now());
        count++;
      }
      db.prepare('UPDATE import_batches SET status = ?, approved_by = ?, approved_at = ?, report = ? WHERE id = ?').run('approved', req.user!.id, now(), JSON.stringify({ ...report, rollback: prior }), b.id);
      bumpCatalog(req.user!.id, `import ${b.filename}`);
      return count;
    });
    audit(db, req.user!.id, 'approve', 'import_batch', b.id, { applied: n });
    res.json({ applied: n, catalogVersion: catalogVersion() });
  }));

  app.post('/api/catalog/imports/:id/rollback', requireRole('admin'), wrap((req, res) => {
    const b = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(req.params.id) as any;
    if (!b || b.status !== 'approved') throw new HttpError(409, 'Only an applied import can be rolled back');
    const prior = (JSON.parse(b.report).rollback ?? {}) as Record<string, { data: string; active: number; is_demo: number } | null>;
    let restored = 0, deactivated = 0;
    tx(db, () => {
      for (const [sku, p] of Object.entries(prior)) {
        if (p) { db.prepare('UPDATE catalog_items SET data = ?, active = ?, is_demo = ?, updated_at = ? WHERE sku = ?').run(p.data, p.active, p.is_demo, now(), sku); restored++; }
        else { db.prepare('UPDATE catalog_items SET active = 0, updated_at = ? WHERE sku = ?').run(now(), sku); deactivated++; } // never hard-delete: sent proposals may reference it
      }
      db.prepare("UPDATE import_batches SET status = 'rolled-back' WHERE id = ?").run(b.id);
      bumpCatalog(req.user!.id, `rollback ${b.filename}`);
    });
    audit(db, req.user!.id, 'rollback', 'import_batch', b.id, { restored, deactivated });
    res.json({ restored, deactivated });
  }));
  /** Product lines missing spec values the calculator needs. */
  app.get('/api/catalog/spec-gaps', requireUser, (_req, res) => {
    const gaps = new Map<string, { key: string; category: string; brand?: string; collection?: string; profile?: string; missing: string[]; skus: number }>();
    for (const i of loadCatalog().filter((x) => x.active && !x.isDemo)) {
      const need: string[] = [];
      if (i.category === 'decking') { if (!i.widthIn) need.push('widthIn'); if (i.spec?.gapIn === undefined) need.push('gapIn'); if (!i.spec?.maxJoistSpacingIn) need.push('maxJoistSpacingIn'); }
      if (i.category === 'concrete' && !i.yieldCuFt) need.push('yieldCuFt');
      if (i.category === 'fastener' && /clip|deck screw|plug/i.test(i.description) && !i.spec?.perCrossing) need.push('perCrossing');
      if (i.category === 'railing-section' && !i.spec?.maxSpanIn) need.push('maxSpanIn');
      if (!need.length) continue;
      const key = [i.category, i.brand, i.category === 'fastener' || i.category === 'concrete' ? i.description : i.collection, i.category === 'decking' && i.material === 'wood' ? i.profile : ''].join('|');
      const g = gaps.get(key) ?? { key, category: i.category, brand: i.brand, collection: i.category === 'fastener' || i.category === 'concrete' ? undefined : i.collection, profile: i.category === 'decking' && i.material === 'wood' ? i.profile : undefined, skuPrefix: i.category === 'fastener' || i.category === 'concrete' ? i.sku : undefined, missing: need, skus: 0 } as any;
      g.skus++;
      gaps.set(key, g);
    }
    res.json([...gaps.values()]);
  });

  app.get('/api/assets', requireUser, (_req, res) => res.json(db.prepare('SELECT * FROM product_assets ORDER BY brand, collection, color').all()));
  app.post('/api/assets', requireRole('admin'), upload.single('file'), wrap((req, res) => {
    const b = req.body ?? {};
    if (!req.file) throw new HttpError(400, 'Attach an image');
    if (!['owned', 'licensed', 'manufacturer-authorized', 'pending', 'unknown'].includes(b.permissionStatus ?? 'unknown')) throw new HttpError(400, 'Invalid permission status');
    const aid = id('ast');
    const fp = path.join(uploadDir, `${aid}${path.extname(req.file.originalname) || '.jpg'}`);
    fs.writeFileSync(fp, req.file.buffer);
    db.prepare('INSERT INTO product_assets (id, sku, brand, collection, color, style, kind, file_path, source_url, permission_status, attribution, retrieved_at, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(aid, b.sku ?? null, b.brand ?? null, b.collection ?? null, b.color ?? null, b.style ?? null, b.kind ?? 'product', fp, b.sourceUrl ?? null, b.permissionStatus ?? 'unknown', b.attribution ?? null, b.retrievedAt ?? null, req.user!.id, now());
    audit(db, req.user!.id, 'upload', 'asset', aid, { sku: b.sku, source: b.sourceUrl });
    res.status(201).json({ id: aid });
  }));
  app.patch('/api/assets/:id', requireRole('admin'), wrap((req, res) => {
    const allowed = ['sku', 'brand', 'collection', 'color', 'style', 'kind', 'source_url', 'permission_status', 'attribution', 'retrieved_at'];
    const sets = Object.keys(req.body ?? {}).filter((k) => allowed.includes(k));
    if (sets.length) db.prepare(`UPDATE product_assets SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...sets.map((k) => req.body[k]), req.params.id);
    res.json({ ok: true });
  }));
  app.delete('/api/assets/:id', requireRole('admin'), wrap((req, res) => {
    db.prepare('DELETE FROM product_assets WHERE id = ?').run(req.params.id);
    audit(db, req.user!.id, 'delete', 'asset', req.params.id);
    res.json({ ok: true });
  }));
  app.get('/api/assets/:id/file', (req, res) => {
    const a = db.prepare('SELECT file_path FROM product_assets WHERE id = ?').get(req.params.id) as any;
    if (!a?.file_path || !fs.existsSync(a.file_path)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600').sendFile(path.resolve(a.file_path));
  });

  app.get('/api/rules', requireUser, (_req, res) => res.json(db.prepare('SELECT id, version, status, active, updated_at, data FROM rule_sets ORDER BY id, version DESC').all().map((r: any) => ({ ...r, data: JSON.parse(r.data) }))));
  app.get('/api/rules/active', requireUser, (_req, res) => res.json(activeRules()));
  app.post('/api/rules', requireRole('admin'), wrap((req, res) => {
    const rs = req.body as RuleSet;
    if (!rs?.id || !rs.jurisdiction || !rs.codeEdition || !rs.source || !rs.effectiveDate) throw new HttpError(400, 'id, jurisdiction, codeEdition, source and effectiveDate are required');
    const v = ((db.prepare('SELECT MAX(version) v FROM rule_sets WHERE id = ?').get(rs.id) as any).v ?? 0) + 1;
    const data = { ...rs, version: v, status: 'draft' as const, reviewer: undefined, reviewedAt: undefined };
    db.prepare('INSERT INTO rule_sets (id, version, data, status, active, updated_at) VALUES (?,?,?,?,0,?)').run(rs.id, v, JSON.stringify(data), 'draft', now());
    audit(db, req.user!.id, 'create', 'rule_set', `${rs.id}@${v}`);
    res.status(201).json({ id: rs.id, version: v });
  }));
  app.post('/api/rules/:id/:version/verify', requireRole('admin'), wrap((req, res) => {
    const r = db.prepare('SELECT * FROM rule_sets WHERE id = ? AND version = ?').get(req.params.id, Number(req.params.version)) as any;
    if (!r) throw new HttpError(404, 'Rule set not found');
    if (!req.body?.reviewer?.trim()) throw new HttpError(422, 'Reviewer name is required to verify a rule set');
    const data = { ...JSON.parse(r.data), status: 'verified', reviewer: req.body.reviewer.trim(), reviewedAt: now() };
    tx(db, () => {
      db.prepare('UPDATE rule_sets SET active = 0').run();
      db.prepare('UPDATE rule_sets SET data = ?, status = ?, active = 1, updated_at = ? WHERE id = ? AND version = ?').run(JSON.stringify(data), 'verified', now(), r.id, r.version);
    });
    audit(db, req.user!.id, 'verify', 'rule_set', `${r.id}@${r.version}`, { reviewer: data.reviewer });
    res.json({ ok: true });
  }));

  app.get('/api/packages', requireUser, (_req, res) => res.json(db.prepare('SELECT data FROM packages').all().map((r: any) => JSON.parse(r.data))));
  app.put('/api/packages/:id', requireRole('admin'), wrap((req, res) => {
    const p = { ...req.body, id: req.params.id };
    if (!p.name) throw new HttpError(400, 'Package name required');
    db.prepare('INSERT INTO packages (id, data, updated_at) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(p.id, JSON.stringify(p), now());
    audit(db, req.user!.id, 'update', 'package', p.id);
    res.json({ ok: true });
  }));
  app.delete('/api/packages/:id', requireRole('admin'), (req, res) => { db.prepare('DELETE FROM packages WHERE id = ?').run(req.params.id); res.json({ ok: true }); });

  // ───────────── Photos & AI ─────────────
  app.post('/api/estimates/:id/photos', requireUser, upload.single('file'), wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    const clientId = String(req.body?.clientId ?? '');
    if (clientId) {
      const ex = db.prepare('SELECT id FROM photos WHERE client_id = ?').get(clientId) as any;
      if (ex) return res.json({ id: ex.id, existing: true }); // retry of an already-stored upload
    }
    if (!req.file) throw new HttpError(400, 'Attach a photo');
    if (!/^image\//.test(req.file.mimetype)) throw new HttpError(400, 'Only images are accepted');
    const pid = id('pho');
    const fp = path.join(uploadDir, `${pid}${path.extname(req.file.originalname) || '.jpg'}`);
    fs.writeFileSync(fp, req.file.buffer); // original preserved byte-for-byte
    db.prepare('INSERT INTO photos (id, estimate_id, client_id, file_path, original_name, mime, size, caption, category, area, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(pid, e.id, clientId || null, fp, req.file.originalname, req.file.mimetype, req.file.size, req.body?.caption ?? null, req.body?.category ?? null, req.body?.area ?? null, req.user!.id, now());
    audit(db, req.user!.id, 'upload', 'photo', e.id, { photoId: pid });
    res.status(201).json({ id: pid });
  }));
  const photoFor = (req: Request) => {
    const p = db.prepare('SELECT * FROM photos WHERE id = ?').get(req.params.id) as any;
    if (!p) throw new HttpError(404, 'Photo not found');
    getEstimate(req, p.estimate_id);
    return p;
  };
  app.get('/api/photos/:id/file', requireUser, wrap((req, res) => {
    const p = photoFor(req);
    res.sendFile(path.resolve(req.query.markup && p.markup_path ? p.markup_path : p.file_path));
  }));
  app.patch('/api/photos/:id', requireUser, wrap((req, res) => {
    const p = photoFor(req);
    const allowed = ['caption', 'category', 'area'];
    const sets = Object.keys(req.body ?? {}).filter((k) => allowed.includes(k));
    if (sets.length) db.prepare(`UPDATE photos SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...sets.map((k) => req.body[k]), p.id);
    res.json({ ok: true });
  }));
  app.post('/api/photos/:id/markup', requireUser, upload.single('file'), wrap((req, res) => {
    const p = photoFor(req);
    if (!req.file) throw new HttpError(400, 'Attach the marked-up image');
    const fp = path.join(uploadDir, `${p.id}-markup.png`);
    fs.writeFileSync(fp, req.file.buffer);
    db.prepare('UPDATE photos SET markup_path = ? WHERE id = ?').run(fp, p.id);
    res.json({ ok: true });
  }));
  app.post('/api/photos/:id/analyze', requireUser, wrap(async (req, res) => {
    const p = photoFor(req);
    if (!aiConfigured()) throw new HttpError(503, 'AI photo assistant is not configured (set ANTHROPIC_API_KEY)', { code: 'not-configured' });
    const items = await analyzePhoto(fs.readFileSync(p.file_path), p.mime, [p.category, p.caption].filter(Boolean).join(' — '));
    const out = items.map((it) => {
      const sid = id('ai');
      db.prepare('INSERT INTO ai_suggestions (id, photo_id, estimate_id, kind, text, status, model, created_at) VALUES (?,?,?,?,?,?,?,?)').run(sid, p.id, p.estimate_id, it.kind, it.text, 'unconfirmed', 'claude-opus-5-5', now());
      return { id: sid, ...it, status: 'unconfirmed' };
    });
    res.json(out);
  }));
  app.patch('/api/ai-suggestions/:id', requireUser, wrap((req, res) => {
    const s = db.prepare('SELECT * FROM ai_suggestions WHERE id = ?').get(req.params.id) as any;
    if (!s) throw new HttpError(404, 'Not found');
    getEstimate(req, s.estimate_id);
    if (!['confirmed', 'dismissed', 'unconfirmed'].includes(req.body?.status)) throw new HttpError(400, 'Invalid status');
    db.prepare('UPDATE ai_suggestions SET status = ?, answer = ? WHERE id = ?').run(req.body.status, req.body.answer ?? null, s.id);
    audit(db, req.user!.id, `ai-${req.body.status}`, 'estimate', s.estimate_id, { suggestion: s.text, answer: req.body.answer });
    res.json({ ok: true });
  }));

  // ───────────── Proposals ─────────────
  app.post('/api/estimates/:id/proposals', requireUser, wrap((req, res) => {
    const e = getEstimate(req, req.params.id);
    const revId = req.body?.revisionId ?? e.current_revision_id;
    const rev = db.prepare('SELECT * FROM estimate_revisions WHERE id = ? AND estimate_id = ?').get(revId, e.id) as any;
    if (!rev) throw new HttpError(404, 'Revision not found');
    const doc = JSON.parse(rev.doc) as EstimateDoc;
    const altIds: string[] = req.body?.alternativeIds?.length ? req.body.alternativeIds : doc.alternatives.filter((a) => a.status !== 'removed').map((a) => a.id);
    const ctx = calcCtx();
    const result = calculate(doc, ctx);
    const issues = altIds.map((a) => isComplete(result, a));
    const blockers = issues.flatMap((i) => i.blockers);
    if (!altIds.length || blockers.length) throw new HttpError(422, 'Estimate is not complete — resolve blockers before creating a proposal', { code: 'incomplete', blockers });
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(e.customer_id) as any;
    const version = ((db.prepare('SELECT MAX(version) v FROM proposals WHERE estimate_id = ?').get(e.id) as any).v ?? 0) + 1;
    const prop = setting('proposal');
    const photoIds = (req.body?.photoIds ?? []) as string[];
    const photos = photoIds.length ? (db.prepare(`SELECT id, caption FROM photos WHERE estimate_id = ? AND id IN (${photoIds.map(() => '?').join(',')})`).all(e.id, ...photoIds) as any[]) : [];
    const { pub, internal } = buildSnapshot({
      version, doc, result, altIds, recommended: req.body?.recommendedId,
      customer: { name: customer.name, address: e.property_address }, company: setting('company'), terms: prop.terms,
      exclusions: [...prop.exclusions, ...((req.body?.exclusions ?? []) as string[])], photoIds: photos.map((p) => ({ id: p.id, caption: p.caption ?? undefined })),
      catalog: new Map(ctx.catalog.map((c) => [c.id, c])),
    });
    const pid = id('prp');
    const token = newToken(24);
    db.prepare('INSERT INTO proposals (id, estimate_id, revision_id, version, token, snapshot, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(pid, e.id, rev.id, version, token, JSON.stringify({ public: pub, internal }), 'ready', req.user!.id, now());
    audit(db, req.user!.id, 'create', 'proposal', pid, { version, revision: rev.number, catalog: pub.frozen.catalogVersion });
    res.status(201).json({ id: pid, version, token });
  }));
  const proposalFor = (req: Request) => {
    const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(req.params.id) as any;
    if (!p) throw new HttpError(404, 'Proposal not found');
    const e = getEstimate(req, p.estimate_id);
    return { p, e, snap: JSON.parse(p.snapshot) as { public: PublicSnapshot; internal: InternalSnapshot } };
  };
  app.get('/api/proposals/:id', requireUser, wrap((req, res) => {
    const { p, snap } = proposalFor(req);
    res.json({ ...p, snapshot: undefined, public: snap.public, internal: { lines: snap.internal.lines, totals: snap.internal.totals }, deliveries: db.prepare('SELECT * FROM deliveries WHERE proposal_id = ? ORDER BY created_at').all(p.id) });
  }));
  app.get('/api/proposals/:id/pdf', requireUser, wrap(async (req, res) => {
    const { snap } = proposalFor(req);
    res.type('application/pdf').send(await proposalPdf(snap.public));
  }));

  const publicUrl = (req: Request, token: string) => `${deps.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`}/p/${token}`;

  app.post('/api/proposals/:id/send', requireUser, wrap(async (req, res) => {
    const { p, e, snap } = proposalFor(req);
    const to = String(req.body?.to ?? '').trim();
    const key = String(req.body?.idempotencyKey ?? '');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw new HttpError(400, 'Enter a valid recipient email');
    if (key.length < 8) throw new HttpError(400, 'idempotencyKey required');
    const existing = db.prepare('SELECT * FROM deliveries WHERE idempotency_key = ?').get(key) as any;
    if (existing) return res.status(existing.status === 'accepted' ? 200 : 202).json(existing); // duplicate tap / retry → same result, no new send
    if (!email.configured) {
      const did = id('dlv');
      db.prepare('INSERT INTO deliveries (id, proposal_id, idempotency_key, channel, recipient, status, provider, error, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(did, p.id, key, 'email', to, 'not-sent', 'none', 'Email provider not configured', now(), now());
      audit(db, req.user!.id, 'send-blocked', 'proposal', p.id, { to, reason: 'email not configured' });
      throw new HttpError(503, 'Email is not connected — nothing was sent. Show the QR code or configure SMTP in Settings.', { code: 'not-configured', deliveryId: did });
    }
    const did = id('dlv');
    db.prepare('INSERT INTO deliveries (id, proposal_id, idempotency_key, channel, recipient, status, provider, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(did, p.id, key, 'email', to, 'sending', 'smtp', now(), now());
    const link = publicUrl(req, p.token);
    const company = snap.public.company.name;
    try {
      const pdf = await proposalPdf(snap.public);
      const r = await email.send({
        to, idempotencyKey: key, subject: `Your deck proposal from ${company}`,
        text: `Hi ${snap.public.customer.name},\n\nThank you for meeting with us. Your proposal is ready: ${link}\n\nThe PDF is attached.\n\n${company}`,
        html: `<p>Hi ${esc(snap.public.customer.name)},</p><p>Thank you for meeting with us. Your proposal is ready:</p><p><a href="${link}">View your proposal</a></p><p>The PDF is attached.</p><p>${esc(company)}</p>`,
        attachments: [{ filename: `proposal-v${p.version}.pdf`, content: pdf }],
      });
      if (!r.accepted) throw new Error(`Rejected by provider: ${r.response ?? 'unknown'}`);
      const t = now();
      const followups = setting('followups');
      tx(db, () => {
        db.prepare('UPDATE deliveries SET status = ?, provider_message_id = ?, updated_at = ? WHERE id = ?').run('accepted', r.providerMessageId ?? null, t, did);
        const first = !p.sent_at;
        db.prepare('UPDATE proposals SET status = CASE WHEN status = \'ready\' THEN \'sent\' ELSE status END, sent_at = coalesce(sent_at, ?) WHERE id = ?').run(t, p.id);
        db.prepare('UPDATE estimate_revisions SET locked = 1, locked_reason = ? WHERE id = ?').run(`Proposal v${p.version} sent ${t}`, p.revision_id);
        db.prepare("UPDATE estimates SET status = CASE WHEN status IN ('draft','review') THEN 'sent' ELSE status END, updated_at = ? WHERE id = ?").run(t, e.id);
        if (first) {
          // Canonical EstimateSent transition — only after a provider-accepted send.
          const dedupe = followups.resendRestartsFollowups ? `EstimateSent:${e.id}:${p.id}` : `EstimateSent:${e.id}`;
          const deal = e.deal_id ? (db.prepare('SELECT * FROM deals WHERE id = ?').get(e.deal_id) as any) : null;
          const cust = db.prepare('SELECT zoho_contact_id FROM customers WHERE id = ?').get(e.customer_id) as any;
          const owner = db.prepare('SELECT id, zoho_user_id FROM users WHERE id = ?').get(e.salesman_id) as any;
          db.prepare('INSERT OR IGNORE INTO outbox (id, event_type, event_version, dedupe_key, payload, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(
            id('evt'), 'EstimateSent', 1, dedupe,
            JSON.stringify({ estimateId: e.id, proposalId: p.id, proposalVersion: p.version, customerId: e.customer_id, zohoContactId: cust?.zoho_contact_id ?? null, zohoDealId: deal?.zoho_deal_id ?? null, ownerUserId: owner?.id, ownerZohoUserId: owner?.zoho_user_id ?? null, sentAt: t, deliveryId: did, recipient: to, dayZero: followups.dayZero, timezone: followups.timezone, targetStage: setting('zohoStages').estimateSent }),
            'pending', t, t,
          );
        }
      });
      audit(db, req.user!.id, 'send', 'proposal', p.id, { to, deliveryId: did });
      processOutbox().catch(() => undefined);
      res.json(db.prepare('SELECT * FROM deliveries WHERE id = ?').get(did));
    } catch (err) {
      db.prepare('UPDATE deliveries SET status = ?, error = ?, updated_at = ? WHERE id = ?').run('failed', (err as Error).message, now(), did);
      audit(db, req.user!.id, 'send-failed', 'proposal', p.id, { to, error: (err as Error).message });
      throw new HttpError(502, `Email was not sent: ${(err as Error).message}`, { code: 'send-failed', deliveryId: did });
    }
  }));
  app.post('/api/proposals/:id/record-approval', requireRole('manager', 'admin'), wrap((req, res) => {
    const { p, e } = proposalFor(req);
    if (!req.body?.name || !req.body?.alternativeId || !req.body?.evidence) throw new HttpError(400, 'Customer name, selected alternative and evidence (e.g. "signed paper proposal") are required');
    approveProposal(p, e, req.body.name, req.body.alternativeId, req.user!.id, `manager-recorded: ${req.body.evidence}`);
    res.json({ ok: true });
  }));
  const approveProposal = (p: any, e: any, name: string, altId: string, userId: string | null, how: string) => {
    const snap = JSON.parse(p.snapshot) as { public: PublicSnapshot };
    if (!snap.public.alternatives.some((a) => a.id === altId)) throw new HttpError(400, 'Unknown option');
    if (p.status === 'approved') return;
    const t = now();
    tx(db, () => {
      db.prepare("UPDATE proposals SET status = 'approved', approved_at = ?, approved_name = ?, approved_alternative = ? WHERE id = ?").run(t, name, altId, p.id);
      db.prepare("UPDATE estimates SET status = 'approved', updated_at = ? WHERE id = ?").run(t, e.id);
      db.prepare('INSERT OR IGNORE INTO outbox (id, event_type, event_version, dedupe_key, payload, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id('evt'), 'EstimateApproved', 1, `EstimateApproved:${e.id}`, JSON.stringify({ estimateId: e.id, proposalId: p.id, alternativeId: altId, approvedAt: t, stopFollowups: true }), 'pending', t, t);
    });
    audit(db, userId, 'approve', 'proposal', p.id, { name, altId, how });
  };

  // Public customer view (token-scoped; never returns internal data)
  const pubProposal = (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new HttpError(404, 'Not found');
    const p = db.prepare('SELECT * FROM proposals WHERE token = ?').get(token) as any;
    if (!p) throw new HttpError(404, 'Not found');
    return p;
  };
  app.get('/api/public/p/:token', wrap((req, res) => {
    const p = pubProposal(req.params.token);
    db.prepare('UPDATE proposals SET view_count = view_count + 1 WHERE id = ?').run(p.id); // viewing never triggers workflow events
    const s = JSON.parse(p.snapshot).public as PublicSnapshot;
    res.set('Cache-Control', 'no-store').json({ ...s, status: p.status, approvedAlternative: p.approved_alternative, approvedName: p.approved_name, approvedAt: p.approved_at });
  }));
  app.get('/api/public/p/:token/pdf', wrap(async (req, res) => {
    const p = pubProposal(req.params.token);
    res.type('application/pdf').send(await proposalPdf(JSON.parse(p.snapshot).public));
  }));
  app.get('/api/public/p/:token/photos/:photoId', wrap((req, res) => {
    const p = pubProposal(req.params.token);
    const s = JSON.parse(p.snapshot).public as PublicSnapshot;
    if (!s.photos.some((x) => x.id === req.params.photoId)) throw new HttpError(404, 'Not found');
    const ph = db.prepare('SELECT file_path, markup_path FROM photos WHERE id = ? AND estimate_id = ?').get(req.params.photoId, p.estimate_id) as any;
    if (!ph) throw new HttpError(404, 'Not found');
    res.sendFile(path.resolve(ph.markup_path ?? ph.file_path));
  }));
  app.post('/api/public/p/:token/approve', wrap((req, res) => {
    const p = pubProposal(req.params.token);
    if (!['sent', 'ready', 'approved'].includes(p.status)) throw new HttpError(409, 'This proposal can no longer be approved');
    const name = String(req.body?.name ?? '').trim();
    if (name.length < 2) throw new HttpError(400, 'Type your full name to approve');
    const e = db.prepare('SELECT * FROM estimates WHERE id = ?').get(p.estimate_id);
    approveProposal(p, e, name, String(req.body?.alternativeId ?? ''), null, `customer link (${req.ip})`);
    res.json({ ok: true, note: 'Approval recorded. Your contract will be prepared for signature — approval is not a signed contract.' });
  }));

  // ───────────── Contracts & hand-off ─────────────
  app.get('/api/contract-templates', requireUser, (_req, res) => res.json(db.prepare('SELECT * FROM contract_templates ORDER BY name').all()));
  app.put('/api/contract-templates/:id', requireRole('admin'), wrap((req, res) => {
    const ex = db.prepare('SELECT version FROM contract_templates WHERE id = ?').get(req.params.id) as any;
    const v = (ex?.version ?? 0) + 1;
    db.prepare('INSERT INTO contract_templates (id, name, body, version, updated_by, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, body = excluded.body, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at').run(req.params.id, req.body?.name ?? 'Contract', String(req.body?.body ?? ''), v, req.user!.id, now());
    audit(db, req.user!.id, 'update', 'contract_template', req.params.id, { version: v });
    res.json({ version: v });
  }));
  app.post('/api/proposals/:id/contract', requireUser, wrap((req, res) => {
    const { p, e, snap } = proposalFor(req);
    if (p.status !== 'approved') throw new HttpError(409, 'Convert to Contract requires a customer-approved proposal', { code: 'not-approved' });
    const ex = db.prepare('SELECT id FROM contracts WHERE proposal_id = ?').get(p.id) as any;
    if (ex) return res.json({ id: ex.id, existing: true });
    const tpl = (db.prepare('SELECT * FROM contract_templates WHERE id = ?').get(req.body?.templateId ?? 'default') as any) ?? null;
    if (!tpl) throw new HttpError(409, 'No contract template configured — an admin must create one');
    const pub = snap.public;
    const alt = pub.alternatives.find((a) => a.id === p.approved_alternative)!;
    const doc = snap.internal.doc;
    const terms = setting('contractTerms');
    const data = {
      company: pub.company, customer: pub.customer, proposal: { version: p.version },
      package: { name: alt.name, decking: alt.decking ?? 'n/a', fascia: alt.fascia ?? 'None', railing: alt.railing ?? 'None' },
      project: { area: pub.project.areaSqFt, perimeter: pub.project.perimeterFt },
      scope: alt.scope.map((g) => `${g.group}:\n${g.items.map((i) => `  - ${i.description} (${i.qty} ${i.unit})`).join('\n')}`).join('\n'),
      selections: pub.selections.map((s) => `  - ${s.label}: ${s.value}`).join('\n'),
      allowances: alt.allowances.length ? alt.allowances.map((a) => `  - ${a.label}: ${money(a.amount)}`).join('\n') : 'None',
      exclusions: pub.exclusions.length ? pub.exclusions.map((x) => `  - ${x}`).join('\n') : 'None listed',
      notes: [doc.consult.customerNotes, doc.consult.priorities].filter(Boolean).join('\n') || 'None',
      price: { total: money(alt.price.total) }, terms,
    };
    const { text, missing } = renderTemplate(tpl.body, data);
    const cid = id('ctr');
    db.prepare('INSERT INTO contracts (id, estimate_id, proposal_id, template_id, template_version, body, generated_body, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(cid, e.id, p.id, tpl.id, tpl.version, text, text, 'draft', req.user!.id, now(), now());
    audit(db, req.user!.id, 'create', 'contract', cid, { proposal: p.version, missing });
    res.status(201).json({ id: cid, missing });
  }));
  const contractFor = (req: Request) => {
    const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(req.params.id) as any;
    if (!c) throw new HttpError(404, 'Contract not found');
    getEstimate(req, c.estimate_id);
    return c;
  };
  app.get('/api/contracts/:id', requireUser, wrap((req, res) => {
    const c = contractFor(req);
    res.json({ ...c, changes: JSON.parse(c.changes), missing: [...c.body.matchAll(/\[\[MISSING: ([\w.]+)\]\]/g)].map((m) => m[1]), handoff: db.prepare('SELECT * FROM handoffs WHERE contract_id = ?').get(c.id) ?? null });
  }));
  app.patch('/api/contracts/:id', requireRole('manager', 'admin'), wrap((req, res) => {
    const c = contractFor(req);
    if (!['draft', 'ready'].includes(c.status)) throw new HttpError(409, 'Contract can no longer be edited');
    const body = String(req.body?.body ?? '');
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw new HttpError(422, 'Describe the reason for the edit');
    const changes = JSON.parse(c.changes);
    changes.push({ at: now(), by: req.user!.name, reason, before: c.body, after: body });
    db.prepare("UPDATE contracts SET body = ?, changes = ?, status = 'draft', updated_at = ? WHERE id = ?").run(body, JSON.stringify(changes), now(), c.id);
    audit(db, req.user!.id, 'edit', 'contract', c.id, { reason });
    res.json({ ok: true });
  }));
  app.post('/api/contracts/:id/ready', requireRole('manager', 'admin'), wrap((req, res) => {
    const c = contractFor(req);
    if (/\[\[MISSING:|\[ADMIN:/.test(c.body)) throw new HttpError(422, 'Fill every [[MISSING]] field and replace the [ADMIN] placeholder with your approved terms first');
    db.prepare("UPDATE contracts SET status = 'ready', updated_at = ? WHERE id = ?").run(now(), c.id);
    res.json({ ok: true });
  }));
  app.post('/api/contracts/:id/send-signature', requireUser, wrap(() => {
    throw new HttpError(503, 'No e-signature provider is connected. Print/email the contract for signature, then a manager records the signed copy.', { code: 'not-configured' });
  }));
  app.post('/api/contracts/:id/record-signed', requireRole('manager', 'admin'), upload.single('file'), wrap((req, res) => {
    const c = contractFor(req);
    if (c.status !== 'ready') throw new HttpError(409, 'Contract must be marked ready before recording a signature');
    if (!req.file) throw new HttpError(400, 'Upload the signed contract (PDF or photo) as verification');
    const fp = path.join(uploadDir, `${c.id}-signed${path.extname(req.file.originalname) || '.pdf'}`);
    fs.writeFileSync(fp, req.file.buffer);
    const t = now();
    const e = db.prepare('SELECT * FROM estimates WHERE id = ?').get(c.estimate_id) as any;
    tx(db, () => {
      db.prepare("UPDATE contracts SET status = 'signed', signed_file = ?, signed_at = ?, signed_recorded_by = ?, updated_at = ? WHERE id = ?").run(fp, t, req.user!.id, t, c.id);
      db.prepare("UPDATE estimates SET status = 'contracted', updated_at = ? WHERE id = ?").run(t, c.estimate_id);
      db.prepare('INSERT OR IGNORE INTO outbox (id, event_type, event_version, dedupe_key, payload, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id('evt'), 'ContractSigned', 1, `ContractSigned:${c.id}`, JSON.stringify({ contractId: c.id, estimateId: c.estimate_id, signedAt: t, targetStage: setting('zohoStages').contractSigned, stopFollowups: true }), 'pending', t, t);
      const prop = db.prepare('SELECT * FROM proposals WHERE id = ?').get(c.proposal_id) as any;
      const snap = JSON.parse(prop.snapshot);
      const deal = e.deal_id ? (db.prepare('SELECT zoho_deal_id FROM deals WHERE id = ?').get(e.deal_id) as any) : null;
      const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(e.customer_id) as any;
      const payload = {
        customer: { id: cust.id, name: cust.name, zohoContactId: cust.zoho_contact_id }, zohoDealId: deal?.zoho_deal_id ?? null,
        contractId: c.id, signedFile: path.basename(fp), proposalVersion: prop.version, approvedAlternative: prop.approved_alternative,
        bom: snap.internal.lines[prop.approved_alternative], selections: snap.public.selections, geometry: snap.internal.doc.geometry,
        stairs: snap.internal.doc.stairs, photos: snap.public.photos, notes: snap.internal.doc.consult.customerNotes ?? '',
        permit: snap.internal.doc.demolition.permitRequired, hoa: snap.internal.doc.demolition.hoaApproval, salesmanId: e.salesman_id,
      };
      db.prepare('INSERT OR IGNORE INTO handoffs (id, contract_id, status, payload, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id('hof'), c.id, 'pending', JSON.stringify(payload), t, t);
    });
    audit(db, req.user!.id, 'signed-recorded', 'contract', c.id, { file: path.basename(fp) });
    processOutbox().catch(() => undefined);
    res.json({ ok: true });
  }));
  app.get('/api/outbox', requireRole('manager', 'admin'), (_req, res) => res.json({ events: db.prepare('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 200').all(), handoffs: db.prepare('SELECT id, contract_id, status, error, external_id, created_at, updated_at FROM handoffs ORDER BY created_at DESC').all() }));
  app.post('/api/outbox/process', requireRole('manager', 'admin'), wrap(async (_req, res) => res.json(await processOutbox())));

  /**
   * Outbox processor. Delivers events to Zoho when configured; otherwise
   * holds them visibly. Events that ORIGINATED from Zoho are never echoed
   * back (loop guard). Follow-up messaging is never activated here.
   */
  async function processOutbox() {
    const stages = setting('zohoStages');
    const pending = db.prepare("SELECT * FROM outbox WHERE status IN ('pending','failed','held-unconfigured') AND attempts < 10 ORDER BY created_at").all() as any[];
    let delivered = 0, held = 0, failed = 0;
    for (const ev of pending) {
      const payload = JSON.parse(ev.payload);
      if (ev.origin === 'zoho') { db.prepare("UPDATE outbox SET status = 'skipped-origin', updated_at = ? WHERE id = ?").run(now(), ev.id); continue; }
      if (!zoho.configured || !stages.confirmed) {
        db.prepare("UPDATE outbox SET status = 'held-unconfigured', last_error = ?, updated_at = ? WHERE id = ?").run(!zoho.configured ? 'Zoho not configured' : 'Zoho stage mapping not confirmed', now(), ev.id);
        held++;
        continue;
      }
      try {
        if ((ev.event_type === 'EstimateSent' || ev.event_type === 'ContractSigned') && payload.zohoDealId && payload.targetStage) await zoho.updateDealStage(payload.zohoDealId, payload.targetStage);
        db.prepare("UPDATE outbox SET status = 'delivered', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(now(), ev.id);
        delivered++;
      } catch (err) {
        db.prepare("UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?").run((err as Error).message, now(), ev.id);
        failed++;
      }
    }
    // Hand-offs to Zoho Projects stay pending until configured.
    if (!zoho.configured || !zohoConfig().projectsPortalId) db.prepare("UPDATE handoffs SET status = 'held-unconfigured', error = 'Zoho Projects not configured', updated_at = ? WHERE status IN ('pending')").run(now());
    return { delivered, held, failed };
  }

  // ───────────── Errors ─────────────
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.body ?? {}) });
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  });
  return { app, processOutbox };
}

/** Merge admin-entered product spec rules into catalog items (rule values never overwrite values from the price book). */
export function applySpecs(item: CatalogItem, rules: ProductSpecRule[]): CatalogItem {
  for (const r of rules) {
    const m = r.match;
    if (m.category && m.category !== item.category) continue;
    if (m.brand && m.brand !== item.brand) continue;
    if (m.collection && m.collection !== item.collection) continue;
    if (m.profile && m.profile !== item.profile) continue;
    if (m.skuPrefix && !item.sku.startsWith(m.skuPrefix)) continue;
    const st = r.set;
    const spec = { ...(item.spec ?? {}) };
    if (st.gapIn !== undefined && spec.gapIn === undefined) spec.gapIn = st.gapIn;
    if (st.maxJoistSpacingIn !== undefined && spec.maxJoistSpacingIn === undefined) spec.maxJoistSpacingIn = st.maxJoistSpacingIn;
    if (st.perCrossing !== undefined && spec.perCrossing === undefined) spec.perCrossing = st.perCrossing;
    if (st.maxSpanIn !== undefined && spec.maxSpanIn === undefined) spec.maxSpanIn = st.maxSpanIn;
    item = {
      ...item, spec,
      widthIn: item.widthIn ?? st.widthIn, heightIn: item.heightIn ?? st.heightIn, yieldCuFt: item.yieldCuFt ?? st.yieldCuFt, packQty: item.packQty ?? st.packQty,
      specSource: [item.specSource, `spec rule ${r.id}: ${r.source}`].filter(Boolean).join('; '),
    };
  }
  return item;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function bootstrap(db: DB, opts: { adminEmail?: string; adminPassword?: string } = {}) {
  const n = (db.prepare('SELECT COUNT(*) n FROM users').get() as any).n as number;
  let generated: string | undefined;
  if (!n) {
    const pw = opts.adminPassword ?? (generated = crypto.randomBytes(9).toString('base64url'));
    db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)').run(id('usr'), opts.adminEmail ?? 'admin@yellowstone.local', 'Administrator', 'admin', hashPassword(pw), now());
  }
  if (!db.prepare('SELECT 1 FROM contract_templates WHERE id = ?').get('default'))
    db.prepare('INSERT INTO contract_templates (id, name, body, version, updated_by, updated_at) VALUES (?,?,?,?,?,?)').run('default', 'Standard deck contract (skeleton)', DEFAULT_CONTRACT_TEMPLATE, 1, 'system', now());
  return { generatedAdminPassword: generated };
}
