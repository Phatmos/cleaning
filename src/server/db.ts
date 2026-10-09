import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Loaded via require so bundlers/test runners do not rewrite the `node:` builtin.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
export type DB = DatabaseSyncT;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','salesman')),
  password_hash TEXT NOT NULL, zoho_user_id TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT, phone TEXT,
  address TEXT, city TEXT, state TEXT, zip TEXT,
  zoho_contact_id TEXT UNIQUE, zoho_account_id TEXT, sms_consent TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), zoho_deal_id TEXT UNIQUE,
  title TEXT, stage TEXT, pipeline TEXT, owner_id TEXT REFERENCES users(id), updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), deal_id TEXT REFERENCES deals(id),
  salesman_id TEXT REFERENCES users(id), starts_at TEXT NOT NULL, ends_at TEXT, address TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled', zoho_event_id TEXT UNIQUE, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS estimates (
  id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id), deal_id TEXT REFERENCES deals(id),
  appointment_id TEXT REFERENCES appointments(id), salesman_id TEXT REFERENCES users(id),
  title TEXT NOT NULL, property_address TEXT, status TEXT NOT NULL DEFAULT 'draft',
  current_revision_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS estimate_revisions (
  id TEXT PRIMARY KEY, estimate_id TEXT NOT NULL REFERENCES estimates(id), number INTEGER NOT NULL,
  doc TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, locked INTEGER NOT NULL DEFAULT 0, locked_reason TEXT,
  parent_revision_id TEXT, label TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT,
  UNIQUE (estimate_id, number)
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY, sku TEXT UNIQUE NOT NULL, data TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  is_demo INTEGER NOT NULL DEFAULT 0, import_batch_id TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS catalog_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, note TEXT, by TEXT);
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY, filename TEXT NOT NULL, uploaded_by TEXT, created_at TEXT NOT NULL,
  status TEXT NOT NULL, headers TEXT NOT NULL, rows TEXT NOT NULL, mapping TEXT, report TEXT,
  approved_by TEXT, approved_at TEXT
);
CREATE TABLE IF NOT EXISTS product_assets (
  id TEXT PRIMARY KEY, sku TEXT, brand TEXT, collection TEXT, color TEXT, style TEXT, kind TEXT,
  file_path TEXT, source_url TEXT, permission_status TEXT NOT NULL DEFAULT 'unknown', attribution TEXT,
  retrieved_at TEXT, uploaded_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_sets (id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL, status TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (id, version));
CREATE TABLE IF NOT EXISTS packages (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY, estimate_id TEXT NOT NULL REFERENCES estimates(id), client_id TEXT UNIQUE,
  file_path TEXT NOT NULL, markup_path TEXT, original_name TEXT, mime TEXT, size INTEGER,
  caption TEXT, category TEXT, area TEXT, uploaded_by TEXT, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY, estimate_id TEXT NOT NULL REFERENCES estimates(id), revision_id TEXT NOT NULL,
  version INTEGER NOT NULL, token TEXT UNIQUE NOT NULL, snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready', created_by TEXT, created_at TEXT NOT NULL,
  sent_at TEXT, approved_at TEXT, approved_name TEXT, approved_alternative TEXT, view_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE (estimate_id, version)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES proposals(id), idempotency_key TEXT UNIQUE NOT NULL,
  channel TEXT NOT NULL, recipient TEXT NOT NULL, status TEXT NOT NULL, provider TEXT, provider_message_id TEXT,
  error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, event_version INTEGER NOT NULL, dedupe_key TEXT UNIQUE NOT NULL,
  payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  origin TEXT NOT NULL DEFAULT 'app', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contract_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY, estimate_id TEXT NOT NULL REFERENCES estimates(id), proposal_id TEXT NOT NULL REFERENCES proposals(id) UNIQUE,
  template_id TEXT NOT NULL, template_version INTEGER NOT NULL, body TEXT NOT NULL, generated_body TEXT NOT NULL,
  status TEXT NOT NULL, changes TEXT NOT NULL DEFAULT '[]', signed_file TEXT, signed_at TEXT, signed_recorded_by TEXT,
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY, contract_id TEXT UNIQUE NOT NULL REFERENCES contracts(id), status TEXT NOT NULL,
  payload TEXT NOT NULL, error TEXT, external_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id TEXT PRIMARY KEY, photo_id TEXT NOT NULL REFERENCES photos(id), estimate_id TEXT NOT NULL,
  kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unconfirmed', answer TEXT, model TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL,
  entity TEXT NOT NULL, entity_id TEXT, detail TEXT
);
`;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  return db;
}

export const now = () => new Date().toISOString();

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function audit(db: DB, userId: string | null, action: string, entity: string, entityId: string | null, detail?: unknown) {
  db.prepare('INSERT INTO audit (at, user_id, action, entity, entity_id, detail) VALUES (?,?,?,?,?,?)').run(now(), userId, action, entity, entityId, detail === undefined ? null : JSON.stringify(detail));
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export function setSetting(db: DB, key: string, value: unknown, by?: string) {
  db.prepare('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by').run(key, JSON.stringify(value), now(), by ?? null);
}
