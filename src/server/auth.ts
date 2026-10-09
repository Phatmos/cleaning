import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Role } from '../shared/types';
import { type DB, now } from './db';

export interface AuthUser { id: string; email: string; name: string; role: Role }

declare module 'express-serve-static-core' {
  interface Request { user?: AuthUser }
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltHex, keyHex] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

export const newToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function createSession(db: DB, userId: string): string {
  const token = newToken();
  const exp = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)').run(token, userId, exp);
  return token;
}

export function authMiddleware(db: DB) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (token) {
      const row = db.prepare('SELECT u.id, u.email, u.name, u.role, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND u.active = 1').get(token) as any;
      if (row && row.expires_at > now()) req.user = { id: row.id, email: row.email, name: row.name, role: row.role };
    }
    next();
  };
}

export const requireUser = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
};
export const requireRole = (...roles: Role[]) => (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (!roles.includes(req.user.role)) return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
  next();
};
