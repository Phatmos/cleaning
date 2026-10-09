import { get, set, del, keys } from 'idb-keyval';

export class ApiError extends Error {
  constructor(public status: number, message: string, public body: any) { super(message); }
}

const TOKEN_KEY = 'ys.token';
export const session = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v: string | null) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.body); }
  const r = await fetch(path, { method: opts.method ?? (body ? 'POST' : 'GET'), headers, body, signal: opts.signal });
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && !path.startsWith('/api/public') && !path.startsWith('/api/auth')) { session.token = null; location.href = '/login'; }
    throw new ApiError(r.status, (data && data.error) || `Request failed (${r.status})`, data);
  }
  return data as T;
}

// ───────────── Durable local storage (IndexedDB) ─────────────
export interface LocalDraft { estimateId: string; revisionId: string; baseVersion: number; doc: any; dirty: boolean; updatedAt: string }
export const drafts = {
  get: (estimateId: string) => get<LocalDraft>(`draft:${estimateId}`).catch(() => undefined),
  put: (d: LocalDraft) => set(`draft:${d.estimateId}`, d).catch(() => undefined),
  remove: (estimateId: string) => del(`draft:${estimateId}`).catch(() => undefined),
};

export interface QueuedPhoto { clientId: string; estimateId: string; blob: Blob; name: string; caption?: string; category?: string; area?: string; status: 'queued' | 'uploading' | 'failed' | 'uploaded'; attempts: number; error?: string; createdAt: string; serverId?: string }
export const photoQueue = {
  put: (p: QueuedPhoto) => set(`photo:${p.clientId}`, p).catch(() => undefined),
  remove: (clientId: string) => del(`photo:${clientId}`).catch(() => undefined),
  async list(estimateId?: string): Promise<QueuedPhoto[]> {
    try {
      const ks = (await keys()).filter((k) => String(k).startsWith('photo:'));
      const all = (await Promise.all(ks.map((k) => get<QueuedPhoto>(k)))).filter(Boolean) as QueuedPhoto[];
      return all.filter((p) => !estimateId || p.estimateId === estimateId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    } catch { return []; }
  },
};

/** Reference data cached for offline calculation. */
export async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  try {
    const v = await fetcher();
    set(`cache:${key}`, v).catch(() => undefined);
    return v;
  } catch (e) {
    const v = await get<T>(`cache:${key}`).catch(() => undefined);
    if (v !== undefined) return v;
    throw e;
  }
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
export const money = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }));
export const timeAgo = (iso?: string) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 10) return 'just now';
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};
