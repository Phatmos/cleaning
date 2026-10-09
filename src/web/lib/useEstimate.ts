import { useCallback, useEffect, useRef, useState } from 'react';
import type { EstimateDoc } from '../../shared/types';
import { api, ApiError, drafts } from './api';

export type SaveStatus = 'loading' | 'saved' | 'saving' | 'pending' | 'offline' | 'error' | 'conflict' | 'locked';

export interface Conflict { mine: EstimateDoc; theirs: EstimateDoc; theirsVersion: number; updatedBy?: string; updatedAt?: string }

/**
 * Autosaving estimate store.
 * - Every edit is written to IndexedDB immediately (survives refresh, app close, offline).
 * - A debounced PUT sends it to the server with the revision's base version.
 * - "Saved" is shown only after the server acknowledges.
 * - Another device's newer save produces an explicit conflict to resolve.
 */
export function useEstimate(estimateId: string) {
  const [meta, setMeta] = useState<any>(null);
  const [doc, setDocState] = useState<EstimateDoc | null>(null);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [lastSavedAt, setLastSavedAt] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const docRef = useRef<EstimateDoc | null>(null);
  const revRef = useRef<string>('');
  const versionRef = useRef(0);
  const seqRef = useRef(0);
  const savedSeqRef = useRef(0);
  const timer = useRef<number | undefined>();
  const inflight = useRef(false);
  const loadToken = useRef(0);

  const persistLocal = (dirty: boolean) => {
    if (!docRef.current) return;
    drafts.put({ estimateId, revisionId: revRef.current, baseVersion: versionRef.current, doc: docRef.current, dirty, updatedAt: new Date().toISOString() });
  };

  const flush = useCallback(async () => {
    if (!docRef.current || inflight.current) return;
    if (seqRef.current === savedSeqRef.current) return;
    if (!navigator.onLine) { setStatus('offline'); return; }
    inflight.current = true;
    const seqAtSend = seqRef.current;
    setStatus('saving');
    try {
      const r = await api<{ version: number; updatedAt: string; doc: EstimateDoc }>(`/api/estimates/${estimateId}/revisions/${revRef.current}`, { method: 'PUT', body: { doc: docRef.current, baseVersion: versionRef.current } });
      versionRef.current = r.version;
      savedSeqRef.current = seqAtSend;
      if (seqRef.current === seqAtSend) {
        // adopt server-normalised doc (stamped overrides, flagged alternatives)
        docRef.current = r.doc;
        setDocState(r.doc);
      }
      persistLocal(seqRef.current !== seqAtSend);
      setLastSavedAt(r.updatedAt);
      setError(undefined);
      setStatus(seqRef.current === seqAtSend ? 'saved' : 'pending');
      if (seqRef.current !== seqAtSend) schedule(300);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.body?.code === 'conflict') {
        setConflict({ mine: docRef.current!, theirs: e.body.server.doc, theirsVersion: e.body.server.version, updatedBy: e.body.server.updatedBy, updatedAt: e.body.server.updatedAt });
        setStatus('conflict');
      } else if (e instanceof ApiError && e.status === 409 && e.body?.code === 'locked') {
        setStatus('locked');
        setError(e.message);
      } else if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        setStatus('error');
        setError(e.message);
      } else {
        setStatus(navigator.onLine ? 'error' : 'offline');
        setError(navigator.onLine ? 'Sync failed — will retry' : undefined);
        schedule(10_000);
      }
    } finally {
      inflight.current = false;
    }
  }, [estimateId]);

  const schedule = (ms = 700) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), ms);
  };

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    const seqAtStart = seqRef.current;
    // A load must never overwrite edits made while it was in flight, and an
    // older load must never win over a newer one.
    const stale = () => token !== loadToken.current || seqRef.current !== seqAtStart;
    if (!docRef.current) setStatus('loading');
    let server: any;
    try {
      server = await api(`/api/estimates/${estimateId}`);
    } catch (e) {
      if (stale()) return;
      const local = await drafts.get(estimateId);
      if (local) {
        docRef.current = local.doc; revRef.current = local.revisionId; versionRef.current = local.baseVersion;
        setDocState(local.doc);
        if (local.dirty) seqRef.current = savedSeqRef.current + 1;
        setStatus('offline');
        setMeta((m: any) => m ?? { offlineOnly: true });
        return;
      }
      setError((e as Error).message);
      setStatus('error');
      return;
    }
    if (stale()) { if (token === loadToken.current) setMeta(server); return; }
    const local = await drafts.get(estimateId);
    if (stale()) { if (token === loadToken.current) setMeta(server); return; }
    setMeta(server);
    revRef.current = server.current.id;
    versionRef.current = server.current.version;
    if (local?.dirty && local.revisionId === server.current.id) {
      if (local.baseVersion === server.current.version) {
        docRef.current = local.doc;
        setDocState(local.doc);
        seqRef.current = savedSeqRef.current + 1;
        setStatus('pending');
        schedule(100);
        return;
      }
      docRef.current = local.doc;
      setDocState(local.doc);
      setConflict({ mine: local.doc, theirs: server.current.doc, theirsVersion: server.current.version, updatedBy: server.current.updated_by, updatedAt: server.current.updated_at });
      setStatus('conflict');
      return;
    }
    docRef.current = server.current.doc;
    setDocState(server.current.doc);
    setLastSavedAt(server.current.updated_at);
    setStatus(server.current.locked ? 'locked' : 'saved');
    persistLocal(false);
  }, [estimateId]);

  useEffect(() => {
    void load();
    const online = () => { if (seqRef.current !== savedSeqRef.current) void flush(); };
    const beforeUnload = (ev: BeforeUnloadEvent) => { if (seqRef.current !== savedSeqRef.current) { persistLocal(true); ev.preventDefault(); } };
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', beforeUnload);
    const iv = window.setInterval(online, 15_000);
    return () => { window.removeEventListener('online', online); window.removeEventListener('beforeunload', beforeUnload); window.clearInterval(iv); window.clearTimeout(timer.current); };
  }, [load, flush]);

  /** Apply an edit. The mutator receives a deep copy it may modify. */
  const update = useCallback((mut: (d: EstimateDoc) => void) => {
    if (!docRef.current) return;
    const next = structuredClone(docRef.current);
    mut(next);
    docRef.current = next;
    setDocState(next);
    seqRef.current++;
    persistLocal(true);
    if (status !== 'locked' && status !== 'conflict') setStatus(navigator.onLine ? 'pending' : 'offline');
    schedule();
  }, [status, flush]);

  const resolveConflict = useCallback(async (choice: 'mine' | 'theirs') => {
    if (!conflict) return;
    versionRef.current = conflict.theirsVersion;
    if (choice === 'theirs') {
      docRef.current = conflict.theirs;
      setDocState(conflict.theirs);
      savedSeqRef.current = seqRef.current;
      persistLocal(false);
      setStatus('saved');
    } else {
      docRef.current = conflict.mine;
      setDocState(conflict.mine);
      seqRef.current++;
      setStatus('pending');
      schedule(50);
    }
    setConflict(null);
  }, [conflict, flush]);

  /** Sent revisions are frozen: copy the current doc into a new revision and keep editing there. */
  const newRevision = useCallback(async (label?: string) => {
    const keep = docRef.current;
    const r = await api(`/api/estimates/${estimateId}/revisions`, { body: { label } });
    const fresh = await api(`/api/estimates/${estimateId}`);
    setMeta(fresh);
    revRef.current = r.id;
    versionRef.current = fresh.current.version;
    if (keep) {
      docRef.current = keep;
      setDocState(keep);
      seqRef.current++;
      setStatus('pending');
      schedule(50);
    }
  }, [estimateId, flush]);

  const refreshMeta = useCallback(async () => {
    try { setMeta(await api(`/api/estimates/${estimateId}`)); } catch { /* offline */ }
  }, [estimateId]);

  return { meta, doc, status, lastSavedAt, error, conflict, update, resolveConflict, newRevision, refreshMeta, flush, reload: load };
}
