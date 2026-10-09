/**
 * DEMO data for trying the app. Every catalog item is flagged isDemo and uses
 * fictitious "DEMO" names and prices — it is NOT company pricing, NOT real
 * manufacturer data, and estimates using it are blocked from being sent.
 * No structural rules are seeded: rule values must come from verified sources.
 */
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, now } from './db';
import { bootstrap } from './app';
import { hashPassword } from './auth';

const dataDir = process.env.DATA_DIR ?? path.resolve('data');
const db = openDb(path.join(dataDir, 'yellowstone.db'));
bootstrap(db, { adminEmail: 'admin@demo.local', adminPassword: 'demo-admin-1' });
const id = (p: string) => `${p}_${crypto.randomBytes(6).toString('hex')}`;

const users: [string, string, string, string][] = [['admin@demo.local', 'Demo Admin', 'admin', 'demo-admin-1'], ['manager@demo.local', 'Morgan Manager', 'manager', 'demo-manager-1'], ['sales@demo.local', 'Sam Sales', 'salesman', 'demo-sales-1']];
const uid: Record<string, string> = {};
for (const [email, name, role, pw] of users) {
  const ex = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any;
  uid[role] = ex?.id ?? id('usr');
  if (!ex) db.prepare('INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?,?,?,?,?,?)').run(uid[role], email, name, role, hashPassword(pw), now());
}

type Item = Record<string, unknown> & { sku: string; description: string; category: string };
const items: Item[] = [];
const add = (i: Item) => items.push({ purchaseUnit: 'each', sale: { method: 'markup', pct: 40 }, source: 'DEMO seed', effectiveDate: '2026-10-01', active: true, ...i });
for (const [col, color] of [['Demo Line', 'Driftwood Gray'], ['Demo Line', 'Walnut Brown'], ['Demo Select', 'Slate']]) {
  for (const L of [12, 16, 20]) add({ sku: `DEMO-CMP-${col.split(' ')[1]}-${color.split(' ')[0]}-${L}`, description: `DEMO composite board ${col} ${color} ${L}'`, category: 'decking', brand: 'DEMO Composite Co.', collection: col, color, material: 'composite', group: `DEMO Composite Co.|${col}|${color}`, widthIn: 5.5, thicknessIn: 1, stockLengthIn: L * 12, cost: L * 3.1, spec: { gapIn: 0.1875, maxJoistSpacingIn: 16 } });
  for (const L of [12]) add({ sku: `DEMO-FAS-${color.split(' ')[0]}-${L}`, description: `DEMO fascia ${color} ${L}'`, category: 'fascia', brand: 'DEMO Composite Co.', collection: 'Fascia', color, material: 'composite', group: `DEMO Composite Co.|Fascia|${color}`, widthIn: 11.25, heightIn: 11.25, stockLengthIn: L * 12, cost: 48 });
}
for (const L of [12, 16]) add({ sku: `DEMO-PT-54-${L}`, description: `DEMO pressure-treated 5/4x6 ${L}'`, category: 'decking', brand: 'DEMO Lumber', collection: 'Pressure-treated', color: 'Natural', material: 'wood', group: 'DEMO Lumber|Pressure-treated|Natural', widthIn: 5.5, thicknessIn: 1, stockLengthIn: L * 12, cost: L * 0.95, spec: { gapIn: 0.125, maxJoistSpacingIn: 16 } });
add({ sku: 'DEMO-CLIP-90', description: 'DEMO hidden clips (box of 90)', category: 'fastener', brand: 'DEMO Composite Co.', purchaseUnit: 'box', packQty: 90, cost: 38, spec: { perCrossing: 1 } });
add({ sku: 'DEMO-SCREW-350', description: 'DEMO deck screws (box of 350)', category: 'fastener', purchaseUnit: 'box', packQty: 350, cost: 32, spec: { perCrossing: 2, compatibleSystems: ['DEMO Lumber|Pressure-treated|Natural'] } });
for (const size of ['2x8', '2x10', '2x12']) for (const L of [8, 10, 12, 14, 16, 20]) add({ sku: `DEMO-PT-${size}-${L}`, description: `DEMO PT ${size} ${L}'`, category: 'joist', profile: size, material: 'wood', stockLengthIn: L * 12, cost: L * (size === '2x8' ? 1.1 : size === '2x10' ? 1.45 : 1.9) });
for (const L of [8, 10, 12]) add({ sku: `DEMO-PT-6x6-${L}`, description: `DEMO PT 6x6 post ${L}'`, category: 'post', profile: '6x6', material: 'wood', stockLengthIn: L * 12, cost: L * 3.2 });
for (const size of ['2x8', '2x10', '2x12']) add({ sku: `DEMO-HGR-${size}`, description: `DEMO joist hanger ${size}`, category: 'hanger', profile: size, cost: 2.1 });
add({ sku: 'DEMO-CONC-80', description: 'DEMO concrete mix 80 lb (yield per demo label)', category: 'concrete', purchaseUnit: 'bag', yieldCuFt: 0.6, cost: 6.5 });
add({ sku: 'DEMO-FLASH-10', description: 'DEMO ledger flashing 10\'', category: 'flashing', stockLengthIn: 120, cost: 18 });
add({ sku: 'DEMO-STRINGER-12', description: 'DEMO PT stringer 12\'', category: 'stringer', stockLengthIn: 144, cost: 24 });
for (const [L, span] of [[6, 72], [8, 96]] as const) add({ sku: `DEMO-RAIL-${L}`, description: `DEMO aluminum rail section ${L}'`, category: 'railing-section', brand: 'DEMO Rail', profile: 'Balusters', purchaseUnit: 'kit', cost: L * 18, spec: { railingSystem: 'DEMO Aluminum Rail', maxSpanIn: span, colors: ['Black', 'White', 'Bronze'] } });
add({ sku: 'DEMO-RAIL-POST', description: 'DEMO aluminum rail post', category: 'railing-post', cost: 42, spec: { railingSystem: 'DEMO Aluminum Rail', colors: ['Black', 'White', 'Bronze'] } });
add({ sku: 'DEMO-RAIL-CAP', description: 'DEMO post cap', category: 'railing-accessory', cost: 6, spec: { railingSystem: 'DEMO Aluminum Rail', per: 'post', perQty: 1 } });
add({ sku: 'DEMO-RAIL-LIGHT', description: 'DEMO post-cap light', category: 'railing-accessory', cost: 28, spec: { railingSystem: 'DEMO Aluminum Rail', per: 'post', perQty: 1 } });
add({ sku: 'DEMO-GATE', description: 'DEMO aluminum gate kit', category: 'gate', cost: 260, spec: { railingSystem: 'DEMO Aluminum Rail' } });
add({ sku: 'DEMO-STAIR-RAIL', description: 'DEMO stair rail kit 8\'', category: 'stair-rail', cost: 190, spec: { railingSystem: 'DEMO Aluminum Rail', maxSpanIn: 96 } });
add({ sku: 'DEMO-RISER-LIGHT', description: 'DEMO riser light', category: 'lighting', cost: 22, spec: { per: 'riser', perQty: 1 } });
add({ sku: 'DEMO-LAB-DECK-C', description: 'DEMO install labor — composite deck', category: 'labor', group: 'deck-sqft', material: 'composite', labor: { unit: 'sqft', rate: 11 }, sale: { method: 'margin', pct: 35 } });
add({ sku: 'DEMO-LAB-DECK-W', description: 'DEMO install labor — wood deck', category: 'labor', group: 'deck-sqft', material: 'wood', labor: { unit: 'sqft', rate: 8 }, sale: { method: 'margin', pct: 35 } });
add({ sku: 'DEMO-LAB-RAIL', description: 'DEMO install labor — railing', category: 'labor', group: 'rail-lf', labor: { unit: 'lf', rate: 14 }, sale: { method: 'margin', pct: 35 } });
add({ sku: 'DEMO-LAB-STAIR', description: 'DEMO install labor — stairs', category: 'labor', group: 'stair-each', labor: { unit: 'each', rate: 450 }, sale: { method: 'margin', pct: 35 } });
add({ sku: 'DEMO-LAB-FOOT', description: 'DEMO labor — footing', category: 'labor', group: 'footing-each', labor: { unit: 'each', rate: 65 }, sale: { method: 'margin', pct: 35 } });
add({ sku: 'DEMO-LAB-DEMO', description: 'DEMO labor — demolition', category: 'labor', group: 'demo-sqft', labor: { unit: 'sqft', rate: 3 }, sale: { method: 'margin', pct: 35 } });

for (const it of items) {
  const ex = db.prepare('SELECT id FROM catalog_items WHERE sku = ?').get(it.sku) as any;
  const cid = ex?.id ?? id('cat');
  const data = JSON.stringify({ ...it, id: cid, isDemo: true });
  if (ex) db.prepare('UPDATE catalog_items SET data = ?, is_demo = 1, updated_at = ? WHERE id = ?').run(data, now(), cid);
  else db.prepare('INSERT INTO catalog_items (id, sku, data, active, is_demo, updated_at) VALUES (?,?,?,1,1,?)').run(cid, it.sku, data, now());
}
db.prepare('INSERT INTO catalog_versions (created_at, note, by) VALUES (?,?,?)').run(now(), 'DEMO seed', 'seed');

if (!db.prepare("SELECT 1 FROM customers WHERE name = 'Jordan Demo'").get()) {
  const day = (h: number, d = 0) => { const t = new Date(); t.setDate(t.getDate() + d); t.setHours(h, 0, 0, 0); return t.toISOString(); };
  for (const [name, addr, h, d, notes] of [['Jordan Demo', '100 Example Ln', 10, 0, 'Wants to replace an old deck off the kitchen; two dogs; budget-conscious'], ['Casey Sample', '200 Sample Ct', 14, 0, 'New deck with stairs to the yard; asked about composite'], ['Riley Placeholder', '300 Test Dr', 9, 1, 'Resurface + new railing']] as const) {
    const c = id('cus');
    db.prepare('INSERT INTO customers (id, name, email, phone, address, city, state, zip, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(c, name, `${name.split(' ')[0].toLowerCase()}@example.com`, '(555) 010-0000', addr, 'Lexington', 'KY', '40500', now(), now());
    const dl = id('deal');
    db.prepare('INSERT INTO deals (id, customer_id, title, stage, pipeline, owner_id, updated_at) VALUES (?,?,?,?,?,?,?)').run(dl, c, `${name} deck`, 'Appointment Scheduled', 'Yellowstone Renovation Sales', uid.salesman, now());
    db.prepare('INSERT INTO appointments (id, customer_id, deal_id, salesman_id, starts_at, address, notes, created_at) VALUES (?,?,?,?,?,?,?,?)').run(id('apt'), c, dl, uid.salesman, day(h, d), `${addr}, Lexington, KY`, notes, now());
  }
}
console.log(`DEMO data loaded (${items.length} demo catalog items, flagged and blocked from sending).
Sign in: sales@demo.local / demo-sales-1 · manager@demo.local / demo-manager-1 · admin@demo.local / demo-admin-1`);
