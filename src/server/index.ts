import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { openDb } from './db';
import { bootstrap, createApp } from './app';

const dataDir = process.env.DATA_DIR ?? path.resolve('data');
const db = openDb(path.join(dataDir, 'yellowstone.db'));
const { generatedAdminPassword } = bootstrap(db, { adminEmail: process.env.ADMIN_EMAIL, adminPassword: process.env.ADMIN_PASSWORD });
if (generatedAdminPassword) console.log(`\n  First run: admin account created → ${process.env.ADMIN_EMAIL ?? 'admin@yellowstone.local'} / ${generatedAdminPassword}\n  Change it after signing in.\n`);

const { app, processOutbox } = createApp({ db, dataDir });
const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}
setInterval(() => processOutbox().catch((e) => console.error('outbox', e)), 60_000).unref();
const port = Number(process.env.PORT ?? 3001);
app.listen(port, process.env.HOST ?? '0.0.0.0', () => console.log(`Yellowstone estimator API on http://localhost:${port}`));
