import { spawnSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.chdir(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error('Install Node.js 24 LTS from https://nodejs.org, then launch again.');
  process.exit(1);
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const env = { ...process.env, DATA_DIR: path.resolve('preview-data'), HOST: '127.0.0.1', PORT: '3001', PUBLIC_BASE_URL: 'http://localhost:3001', ADMIN_EMAIL: 'admin@demo.local', ADMIN_PASSWORD: 'demo-admin-1' };
for (const key of Object.keys(env)) if (/^(SMTP_|ZOHO_|ANTHROPIC_)/.test(key)) delete env[key];
function run(args) {
  const result = spawnSync(npm, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!existsSync('node_modules/.bin/tsx')) run(['ci']);
run(['run', 'build']);
if (!existsSync('preview-data/yellowstone.db')) run(['run', 'seed:demo']);
console.log('\nPREVIEW: http://localhost:3001\nLogin: admin@demo.local\nPassword: demo-admin-1\nDemo prices only. Keep this window open; Ctrl+C stops the app.\n');
const server = spawn(npm, ['start'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
let opened = false;
const poll = setInterval(async () => {
  try {
    const r = await fetch('http://localhost:3001/api/health');
    if (!r.ok || opened) return;
    opened = true; clearInterval(poll);
    const command = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', 'http://localhost:3001'] : ['http://localhost:3001'];
    const opener = spawn(command, args, { stdio: 'ignore' });
    opener.on('error', () => console.log('Open http://localhost:3001 in your browser.'));
  } catch {}
}, 1000);
server.on('exit', code => { clearInterval(poll); process.exit(code || 0); });
