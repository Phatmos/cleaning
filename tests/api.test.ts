import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, setSetting, now, type DB } from '../src/server/db';
import { bootstrap, createApp } from '../src/server/app';
import { hashPassword } from '../src/server/auth';
import type { EmailProvider } from '../src/server/integrations';
import { completeDoc, testCatalog, verifiedTestRules } from './fixtures';

let db: DB;
let app: any;
let sent: any[];
let emailOn: boolean;

function fakeEmail(): EmailProvider {
  return {
    get configured() { return emailOn; },
    async send(m) { sent.push(m); return { accepted: true, providerMessageId: `msg-${sent.length}` }; },
  };
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082', 'hex');

async function login(email: string) {
  const r = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
  expect(r.status).toBe(200);
  return { Authorization: `Bearer ${r.body.token}` };
}

function seed() {
  for (const [id, role] of [['u_admin', 'admin'], ['u_mgr', 'manager'], ['u_sam', 'salesman'], ['u_bob', 'salesman']] as const)
    db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)').run(id, `${id}@t.io`, id, role, hashPassword('password123'), now());
  for (const it of testCatalog) db.prepare('INSERT INTO catalog_items (id, sku, data, active, is_demo, updated_at) VALUES (?,?,?,1,0,?)').run(it.id, it.sku, JSON.stringify(it), now());
  db.prepare('INSERT INTO catalog_versions (created_at, note) VALUES (?,?)').run(now(), 'seed');
  db.prepare('INSERT INTO rule_sets (id, version, data, status, active, updated_at) VALUES (?,?,?,?,1,?)').run('TEST-RULES', 1, JSON.stringify(verifiedTestRules), 'verified', now());
  setSetting(db, 'tax', { configured: true, ratePct: 6, base: 'materials' });
  setSetting(db, 'laborMap', null); // fixtures use group-based labor items
  db.prepare('INSERT INTO customers (id, name, email, address, city, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run('c1', 'Jane Customer', 'jane@x.io', '1 Main St', 'Lexington', 'KY', now(), now());
  db.prepare('INSERT INTO customers (id, name, created_at, updated_at) VALUES (?,?,?,?)').run('c2', 'Other Customer', now(), now());
  db.prepare('INSERT INTO deals (id, customer_id, zoho_deal_id, owner_id, updated_at) VALUES (?,?,?,?,?)').run('d1', 'c1', 'Z-1', 'u_sam', now());
  db.prepare('INSERT INTO appointments (id, customer_id, deal_id, salesman_id, starts_at, created_at) VALUES (?,?,?,?,?,?)').run('a1', 'c1', 'd1', 'u_sam', new Date(Date.now() + 3600e3).toISOString(), now());
  db.prepare('INSERT INTO appointments (id, customer_id, salesman_id, starts_at, created_at) VALUES (?,?,?,?,?)').run('a2', 'c2', 'u_bob', new Date(Date.now() + 3600e3).toISOString(), now());
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ys-'));
  db = openDb(':memory:');
  bootstrap(db, { adminEmail: 'boot@t.io', adminPassword: 'password123' });
  seed();
  sent = [];
  emailOn = false;
  app = createApp({ db, dataDir: dir, email: fakeEmail(), publicBaseUrl: 'https://est.example' }).app;
});

async function startEstimate(h: any) {
  const r = await request(app).post('/api/appointments/a1/estimate').set(h);
  expect([200, 201]).toContain(r.status);
  const e = await request(app).get(`/api/estimates/${r.body.id}`).set(h);
  return { id: r.body.id as string, rev: e.body.current.id as string, version: e.body.current.version as number };
}

describe('visits, customers and access', () => {
  it('salesman sees only assigned visits and customers', async () => {
    const sam = await login('u_sam@t.io');
    const v = await request(app).get('/api/visits').set(sam);
    expect(v.body.map((x: any) => x.id)).toEqual(['a1']);
    const c = await request(app).get('/api/customers').set(sam);
    expect(c.body.map((x: any) => x.id)).toEqual(['c1']);
    expect((await request(app).get('/api/customers/c2').set(sam)).status).toBe(403);
  });
  it('starting an estimate from a visit is idempotent and links CRM ids', async () => {
    const sam = await login('u_sam@t.io');
    const a = await startEstimate(sam);
    const again = await request(app).post('/api/appointments/a1/estimate').set(sam);
    expect(again.body.id).toBe(a.id);
    const e = await request(app).get(`/api/estimates/${a.id}`).set(sam);
    expect(e.body.estimate.deal_id).toBe('d1');
    expect(e.body.deal.zoho_deal_id).toBe('Z-1');
    const bob = await login('u_bob@t.io');
    expect((await request(app).get(`/api/estimates/${a.id}`).set(bob)).status).toBe(403);
  });
});

describe('persistence and concurrency', () => {
  it('saves, reloads exactly, and rejects stale writes from another device', async () => {
    const sam = await login('u_sam@t.io');
    const { id, rev, version } = await startEstimate(sam);
    const doc = completeDoc();
    doc.ui = { mode: 'technical', consultStep: 9, techStep: 3 };
    const s1 = await request(app).put(`/api/estimates/${id}/revisions/${rev}`).set(sam).send({ doc, baseVersion: version });
    expect(s1.status).toBe(200);
    expect(s1.body.version).toBe(version + 1);
    const reload = await request(app).get(`/api/estimates/${id}`).set(sam);
    expect(reload.body.current.doc.ui).toEqual({ mode: 'technical', consultStep: 9, techStep: 3 });
    expect(reload.body.current.doc.geometry.shapes[0].w).toBe(192);
    const stale = await request(app).put(`/api/estimates/${id}/revisions/${rev}`).set(sam).send({ doc, baseVersion: version });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('conflict');
    expect(stale.body.server.version).toBe(version + 1);
  });
  it('overrides need a reason, are stamped server-side and audited; price overrides are role-restricted', async () => {
    const sam = await login('u_sam@t.io');
    const { id, rev, version } = await startEstimate(sam);
    const doc = completeDoc();
    doc.overrides['decking:TB-16'] = { value: 30, reason: '', by: 'x', at: 'x' };
    expect((await request(app).put(`/api/estimates/${id}/revisions/${rev}`).set(sam).send({ doc, baseVersion: version })).status).toBe(422);
    doc.overrides['decking:TB-16'].reason = 'Spare boards';
    const ok = await request(app).put(`/api/estimates/${id}/revisions/${rev}`).set(sam).send({ doc, baseVersion: version });
    expect(ok.status).toBe(200);
    expect(ok.body.doc.overrides['decking:TB-16'].by).toBe('u_sam');
    const d2 = ok.body.doc;
    d2.pricing.priceOverrides['decking:TB-16'] = { value: 1, reason: 'friend', by: 'x', at: 'x' };
    expect((await request(app).put(`/api/estimates/${id}/revisions/${rev}`).set(sam).send({ doc: d2, baseVersion: ok.body.version })).status).toBe(403);
    d2.pricing.priceOverrides = {};
    d2.pricing.discountPct = 5;
    d2.pricing.discountReason = 'loyal';
    expect((await request(app).put(`/api/estimates/${id}/revisions/${rev}`).set(sam).send({ doc: d2, baseVersion: ok.body.version })).status).toBe(403);
    const act = await request(app).get(`/api/estimates/${id}/activity`).set(sam);
    expect(act.body.some((a: any) => a.action === 'override')).toBe(true);
  });
  it('photo upload retries with the same client id do not duplicate', async () => {
    const sam = await login('u_sam@t.io');
    const { id } = await startEstimate(sam);
    const up = () => request(app).post(`/api/estimates/${id}/photos`).set(sam).field('clientId', 'cli-123').field('caption', 'Ledger').attach('file', PNG, { filename: 'p.png', contentType: 'image/png' });
    const a = await up();
    const b = await up();
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.existing).toBe(true);
    const e = await request(app).get(`/api/estimates/${id}`).set(sam);
    expect(e.body.photos).toHaveLength(1);
  });
});

describe('proposals, sending and lifecycle', () => {
  async function readyProposal() {
    const sam = await login('u_sam@t.io');
    const { id, rev, version } = await startEstimate(sam);
    const s = await request(app).put(`/api/estimates/${id}/revisions/${rev}`).set(sam).send({ doc: completeDoc(), baseVersion: version });
    expect(s.status).toBe(200);
    const p = await request(app).post(`/api/estimates/${id}/proposals`).set(sam).send({ recommendedId: 'alt1' });
    expect(p.status).toBe(201);
    return { sam, id, rev, proposal: p.body };
  }
  it('incomplete estimates cannot become proposals', async () => {
    const sam = await login('u_sam@t.io');
    const { id } = await startEstimate(sam);
    const p = await request(app).post(`/api/estimates/${id}/proposals`).set(sam).send({});
    expect(p.status).toBe(422);
  });
  it('unconfigured email never pretends to send and creates no follow-up event', async () => {
    const { sam, proposal } = await readyProposal();
    const r = await request(app).post(`/api/proposals/${proposal.id}/send`).set(sam).send({ to: 'jane@x.io', idempotencyKey: 'k-000001' });
    expect(r.status).toBe(503);
    expect(sent).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) n FROM outbox').get()).toEqual({ n: 0 });
  });
  it('real send is idempotent, locks the revision and emits exactly one EstimateSent', async () => {
    emailOn = true;
    const { sam, id, rev, proposal } = await readyProposal();
    const a = await request(app).post(`/api/proposals/${proposal.id}/send`).set(sam).send({ to: 'jane@x.io', idempotencyKey: 'k-000001' });
    const b = await request(app).post(`/api/proposals/${proposal.id}/send`).set(sam).send({ to: 'jane@x.io', idempotencyKey: 'k-000001' });
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('accepted');
    expect(b.body.id).toBe(a.body.id);
    expect(sent).toHaveLength(1);
    await request(app).post(`/api/proposals/${proposal.id}/send`).set(sam).send({ to: 'jane@x.io', idempotencyKey: 'k-000002' }); // deliberate resend
    expect(sent).toHaveLength(2);
    const ev = db.prepare("SELECT * FROM outbox WHERE event_type = 'EstimateSent'").all() as any[];
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].payload).zohoDealId).toBe('Z-1');
    // revision locked; edits require a new revision
    const e = await request(app).get(`/api/estimates/${id}`).set(sam);
    const lockedSave = await request(app).put(`/api/estimates/${id}/revisions/${rev}`).set(sam).send({ doc: completeDoc(), baseVersion: e.body.current.version });
    expect(lockedSave.status).toBe(409);
    expect(lockedSave.body.code).toBe('locked');
    const nr = await request(app).post(`/api/estimates/${id}/revisions`).set(sam).send({});
    expect(nr.body.number).toBe(2);
  });
  it('sent proposals keep their prices after catalog updates', async () => {
    emailOn = true;
    const { sam, proposal } = await readyProposal();
    const before = (await request(app).get(`/api/public/p/${proposal.token}`)).body.alternatives[0].price.total;
    const admin = await login('u_admin@t.io');
    const item = testCatalog.find((c) => c.sku === 'TB-16')!;
    expect((await request(app).patch(`/api/catalog/items/${item.id}`).set(admin).send({ cost: 999 })).status).toBe(200);
    const after = (await request(app).get(`/api/public/p/${proposal.token}`)).body.alternatives[0].price.total;
    expect(after).toBe(before);
    void sam;
  });
  it('public link exposes no cost, margin, internal notes or other customers', async () => {
    const { proposal } = await readyProposal();
    const r = await request(app).get(`/api/public/p/${proposal.token}`);
    expect(r.status).toBe(200);
    const s = JSON.stringify(r.body);
    for (const bad of ['cost', 'margin', 'markup', 'internal', 'unitCost', 'extCost', 'Other Customer', 'u_sam']) expect(s.toLowerCase()).not.toContain(bad.toLowerCase());
    expect((await request(app).get('/api/public/p/not-a-real-token-xxxxxxxx')).status).toBe(404);
    expect((await request(app).get(`/api/proposals/${proposal.id}`)).status).toBe(401);
  });
  it('approval ≠ signed contract; contract needs approval, signature recording, idempotent hand-off', async () => {
    const { sam, proposal } = await readyProposal();
    expect((await request(app).post(`/api/proposals/${proposal.id}/contract`).set(sam).send({})).status).toBe(409);
    expect((await request(app).post(`/api/public/p/${proposal.token}/approve`).send({ name: 'Jane Customer', alternativeId: 'alt1' })).status).toBe(200);
    const c = await request(app).post(`/api/proposals/${proposal.id}/contract`).set(sam).send({});
    expect(c.status).toBe(201);
    expect(c.body.missing).toContain('terms.payment');
    const c2 = await request(app).post(`/api/proposals/${proposal.id}/contract`).set(sam).send({});
    expect(c2.body.id).toBe(c.body.id);
    const mgr = await login('u_mgr@t.io');
    expect((await request(app).post(`/api/contracts/${c.body.id}/ready`).set(mgr)).status).toBe(422);
    const body = (await request(app).get(`/api/contracts/${c.body.id}`).set(mgr)).body.body.replace(/\[\[MISSING: [\w.]+\]\]/g, 'n/a').replace(/\[ADMIN:[^\]]*\]/, 'Approved terms');
    expect((await request(app).patch(`/api/contracts/${c.body.id}`).set(mgr).send({ body, reason: 'Filled terms' })).status).toBe(200);
    expect((await request(app).post(`/api/contracts/${c.body.id}/ready`).set(mgr)).status).toBe(200);
    expect((await request(app).post(`/api/contracts/${c.body.id}/send-signature`).set(mgr)).status).toBe(503);
    const signed = await request(app).post(`/api/contracts/${c.body.id}/record-signed`).set(mgr).attach('file', Buffer.from('%PDF-1.4'), { filename: 'signed.pdf', contentType: 'application/pdf' });
    expect(signed.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) n FROM handoffs').get()).toEqual({ n: 1 });
    const again = await request(app).post(`/api/contracts/${c.body.id}/record-signed`).set(mgr).attach('file', Buffer.from('%PDF-1.4'), { filename: 'signed.pdf', contentType: 'application/pdf' });
    expect(again.status).toBe(409);
    expect(db.prepare('SELECT COUNT(*) n FROM handoffs').get()).toEqual({ n: 1 });
  });
});

describe('price-list import', () => {
  it('previews, maps, validates (missing fields, duplicates) and applies only on approval', async () => {
    const admin = await login('u_admin@t.io');
    const csv = 'Item Number,Description,Category,Length,Unit Cost,Sale Rule,Pct\nNEW-1,New board,decking,16,40,markup,35\nNEW-1,Dup,decking,16,40,markup,35\nBAD,No cat,,12,5,,\n';
    const up = await request(app).post('/api/catalog/imports').set(admin).attach('file', Buffer.from(csv), { filename: 'prices.csv', contentType: 'text/csv' });
    expect(up.status).toBe(201);
    expect(up.body.mapping.sku).toBe('Item Number');
    const mapping = { ...up.body.mapping, saleMethod: 'Sale Rule', salePct: 'Pct' };
    const rep = await request(app).put(`/api/catalog/imports/${up.body.id}/mapping`).set(admin).send({ mapping });
    expect(rep.body.counts.create).toBe(1);
    expect(rep.body.counts.skip).toBe(2);
    expect(rep.body.rows[0].warnings.some((w: string) => /board width/.test(w))).toBe(true);
    expect(rep.body.missingFields).toContain('Actual width (in)');
    const cat0 = (await request(app).get('/api/catalog').set(admin)).body;
    expect(cat0.items.some((i: any) => i.sku === 'NEW-1')).toBe(false);
    const ap = await request(app).post(`/api/catalog/imports/${up.body.id}/approve`).set(admin);
    expect(ap.body.applied).toBe(1);
    const cat1 = (await request(app).get('/api/catalog').set(admin)).body;
    expect(cat1.items.find((i: any) => i.sku === 'NEW-1').stockLengthIn).toBe(192);
    expect(cat1.version).not.toBe(cat0.version);
    const sam = await login('u_sam@t.io');
    expect((await request(app).post(`/api/catalog/imports/${up.body.id}/approve`).set(sam)).status).toBe(403);
  });
});
