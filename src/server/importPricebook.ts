/**
 * One-time / scheduled import from the command line:
 *   npm run import:pricebook -- <file.xlsx|.xls|.csv> [...more files]
 * Same parser, validation and versioning as Admin › Price lists. Rows with errors
 * are skipped and listed; nothing is guessed.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { audit, now, openDb, tx } from './db';
import { bootstrap } from './app';
import { parseUpload, suggestMapping, validateBatch } from './catalogImport';

const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: npm run import:pricebook -- <file> [...]'); process.exit(1); }
const dataDir = process.env.DATA_DIR ?? path.resolve('data');
const db = openDb(path.join(dataDir, 'yellowstone.db'));
bootstrap(db, { adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD });
for (const f of files) {
  const parsed = await parseUpload(f, fs.readFileSync(f));
  const mapping = suggestMapping(parsed.headers);
  if (!mapping.__format) { console.error(`${f}: not a recognized Leap price book — use Admin › Price lists to map its columns`); continue; }
  const existing = new Set((db.prepare('SELECT sku FROM catalog_items').all() as any[]).map((r) => r.sku));
  const report = validateBatch(parsed.headers, parsed.rows, mapping, existing, path.basename(f));
  const bid = `imp_${crypto.randomBytes(8).toString('hex')}`;
  const prior: Record<string, unknown> = {};
  tx(db, () => {
    for (const r of report.rows) {
      if (!r.item) continue;
      const ex = db.prepare('SELECT id, data, active, is_demo FROM catalog_items WHERE sku = ?').get(r.item.sku) as any;
      prior[r.item.sku] = ex ? { data: ex.data, active: ex.active, is_demo: ex.is_demo } : null;
      const id = ex?.id ?? `cat_${crypto.randomBytes(8).toString('hex')}`;
      const data = JSON.stringify({ ...r.item, id });
      if (ex) db.prepare('UPDATE catalog_items SET data = ?, active = ?, is_demo = 0, import_batch_id = ?, updated_at = ? WHERE id = ?').run(data, r.item.active ? 1 : 0, bid, now(), id);
      else db.prepare('INSERT INTO catalog_items (id, sku, data, active, is_demo, import_batch_id, updated_at) VALUES (?,?,?,?,0,?,?)').run(id, r.item.sku, data, r.item.active ? 1 : 0, bid, now());
    }
    db.prepare('INSERT INTO import_batches (id, filename, uploaded_by, created_at, status, headers, rows, mapping, report, approved_by, approved_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(bid, path.basename(f), 'cli', now(), 'approved', JSON.stringify(parsed.headers), JSON.stringify(parsed.rows), JSON.stringify(mapping), JSON.stringify({ ...report, rollback: prior }), 'cli', now());
    db.prepare('INSERT INTO catalog_versions (created_at, note, by) VALUES (?,?,?)').run(now(), `cli import ${path.basename(f)}`, 'cli');
  });
  audit(db, null, 'cli-import', 'import_batch', bid, report.counts);
  console.log(`${path.basename(f)} [${mapping.__format}, sheet "${parsed.sheet ?? '-'}"]: ${report.counts.create} new, ${report.counts.update} updated, ${report.counts.skip} skipped`);
  for (const r of report.rows.filter((x) => x.errors.length).slice(0, 20)) console.log(`  row ${r.row}: ${r.errors.join('; ')}`);
  if (report.missingFields.length) console.log(`  not in file: ${report.missingFields.join(', ')}`);
}
console.log('Next: Admin › Product specs lists the product lines that still need installation specs.');
