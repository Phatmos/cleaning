import { useCallback, useEffect, useRef, useState } from 'react';
import type { StepProps } from '../Estimate';
import { api, ApiError, photoQueue, session, uid, type QueuedPhoto } from '../../lib/api';
import { Segmented, Sheet, useToast } from '../../components/ui';

const CATS = [['existing-deck', 'Existing deck'], ['house-wall', 'House wall'], ['site', 'Site'], ['access', 'Access'], ['damage', 'Damage'], ['inspiration', 'Inspiration'], ['other', 'Other']] as const;

/** Upload one queued photo; retries are safe because the server dedupes by clientId. */
async function uploadOne(p: QueuedPhoto): Promise<QueuedPhoto> {
  const form = new FormData();
  form.append('clientId', p.clientId);
  if (p.caption) form.append('caption', p.caption);
  if (p.category) form.append('category', p.category);
  if (p.area) form.append('area', p.area);
  form.append('file', p.blob, p.name);
  const r = await api(`/api/estimates/${p.estimateId}/photos`, { form, method: 'POST' });
  return { ...p, status: 'uploaded', serverId: r.id };
}

export function Photos({ estimateId, meta, refreshMeta }: StepProps) {
  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  const [markup, setMarkup] = useState<any>(null);
  const [ai, setAi] = useState<Record<string, string>>({});
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);

  const pump = useCallback(async () => {
    if (busy.current || !navigator.onLine) return;
    busy.current = true;
    try {
      for (const p of await photoQueue.list(estimateId)) {
        if (p.status === 'uploaded') { await photoQueue.remove(p.clientId); continue; }
        const up = { ...p, status: 'uploading' as const, attempts: p.attempts + 1 };
        await photoQueue.put(up);
        setQueue(await photoQueue.list(estimateId));
        try {
          await uploadOne(up);
          await photoQueue.remove(p.clientId); // original kept server-side; local copy no longer needed
        } catch (e) {
          await photoQueue.put({ ...up, status: 'failed', error: (e as Error).message });
        }
      }
    } finally {
      busy.current = false;
      setQueue(await photoQueue.list(estimateId));
      void refreshMeta();
    }
  }, [estimateId, refreshMeta]);

  useEffect(() => {
    photoQueue.list(estimateId).then(setQueue);
    void pump();
    const on = () => void pump();
    window.addEventListener('online', on);
    const iv = setInterval(on, 20_000);
    return () => { window.removeEventListener('online', on); clearInterval(iv); };
  }, [pump]);

  const add = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      await photoQueue.put({ clientId: uid(), estimateId, blob: f, name: f.name || 'photo.jpg', status: 'queued', attempts: 0, createdAt: new Date().toISOString(), category: 'existing-deck' });
    }
    setQueue(await photoQueue.list(estimateId));
    void pump();
  };

  const photos: any[] = meta?.photos ?? [];
  const suggestions: any[] = meta?.aiSuggestions ?? [];
  const analyze = async (id: string) => {
    try { await api(`/api/photos/${id}/analyze`, { method: 'POST' }); await refreshMeta(); }
    catch (e) { toast(e instanceof ApiError && e.body?.code === 'not-configured' ? 'AI assistant is not connected (optional). Ask an admin to add an API key.' : (e as Error).message); }
  };
  const decide = async (s: any, status: 'confirmed' | 'dismissed') => {
    await api(`/api/ai-suggestions/${s.id}`, { method: 'PATCH', body: { status, answer: ai[s.id] } });
    await refreshMeta();
  };
  const patch = async (id: string, body: any) => { await api(`/api/photos/${id}`, { method: 'PATCH', body }); await refreshMeta(); };
  const src = (id: string, mk?: boolean) => `/api/photos/${id}/file?${mk ? 'markup=1&' : ''}t=${encodeURIComponent(session.token ?? '')}`;

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row">
        <h3 style={{ margin: 0, flex: 1 }}>Project photos</h3>
        <input ref={input} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => { void add(e.target.files); e.target.value = ''; }} />
        <button className="btn primary" onClick={() => input.current?.click()}>📷 Take or add photos</button>
      </div>
      {queue.length > 0 && (
        <div className="group">
          {queue.map((q) => (
            <div key={q.clientId} className="item">
              <img src={URL.createObjectURL(q.blob)} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8 }} />
              <div style={{ flex: 1 }}>{q.name}<div className="small">{q.status === 'failed' ? `Upload failed (attempt ${q.attempts}) — ${q.error}. Will retry.` : q.status === 'uploading' ? 'Uploading…' : navigator.onLine ? 'Waiting to upload' : 'Saved on this device — uploads when back online'}</div></div>
              <span className={`pill ${q.status === 'failed' ? 'red' : 'blue'}`}>{q.status}</span>
              {q.status === 'failed' && <button className="btn small" onClick={() => void pump()}>Retry</button>}
            </div>
          ))}
        </div>
      )}
      {photos.length === 0 && queue.length === 0 ? <div className="card small">No photos yet. Capture the existing deck, the house wall where a ledger would attach, access to the backyard, and anything the customer points out.</div> : (
        <div className="grid">
          {photos.map((p) => (
            <div key={p.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
              <AuthedImg src={`/api/photos/${p.id}/file${p.has_markup ? '?markup=1' : ''}`} />
              <div style={{ padding: 12 }} className="col">
                <input className="input" placeholder="Caption" defaultValue={p.caption ?? ''} onBlur={(e) => e.target.value !== (p.caption ?? '') && patch(p.id, { caption: e.target.value })} />
                <select className="input" value={p.category ?? ''} onChange={(e) => patch(p.id, { category: e.target.value })}>
                  <option value="">Category…</option>
                  {CATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn small" onClick={() => setMarkup(p)}>✎ Mark up</button>
                  <button className="btn small" onClick={() => analyze(p.id)}>✦ Suggest questions</button>
                </div>
                {suggestions.filter((s) => s.photo_id === p.id && s.status === 'unconfirmed').map((s) => (
                  <div key={s.id} className="issue review" style={{ flexDirection: 'column', gap: 6 }}>
                    <div><span className="pill">{s.kind === 'question' ? 'Ask' : 'Check'}</span> {s.text}</div>
                    <input className="input" placeholder="What you confirmed on site" value={ai[s.id] ?? ''} onChange={(e) => setAi({ ...ai, [s.id]: e.target.value })} />
                    <div className="row" style={{ gap: 6 }}><button className="btn small primary" onClick={() => decide(s, 'confirmed')}>Confirm</button><button className="btn small" onClick={() => decide(s, 'dismissed')}>Dismiss</button></div>
                  </div>
                ))}
                {suggestions.filter((s) => s.photo_id === p.id && s.status === 'confirmed').map((s) => <div key={s.id} className="small">✓ {s.text}{s.answer ? ` — ${s.answer}` : ''}</div>)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="small">AI suggestions are prompts for you to check — they never set dimensions, quantities, prices or structural conclusions. Original photos are always kept; markup is saved as a separate copy.</div>
      <MarkupSheet photo={markup} onClose={() => setMarkup(null)} onSaved={async () => { setMarkup(null); await refreshMeta(); }} />
    </div>
  );
}

/** <img> that sends the bearer token (photos are private). */
export function AuthedImg({ src, style }: { src: string; style?: React.CSSProperties }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let revoke: string | undefined;
    fetch(src, { headers: { Authorization: `Bearer ${session.token}` } }).then((r) => r.blob()).then((b) => { revoke = URL.createObjectURL(b); setUrl(revoke); }).catch(() => undefined);
    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [src]);
  return url ? <img src={url} alt="" style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', display: 'block', ...style }} /> : <div style={{ aspectRatio: '4/3', background: 'var(--bg-sunken)' }} />;
}

function MarkupSheet({ photo, onClose, onSaved }: { photo: any; onClose: () => void; onSaved: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [color, setColor] = useState('#ff3b30');
  const drawing = useRef(false);
  const toast = useToast();
  useEffect(() => {
    if (!photo) return;
    fetch(`/api/photos/${photo.id}/file`, { headers: { Authorization: `Bearer ${session.token}` } }).then((r) => r.blob()).then(async (b) => {
      const img = await createImageBitmap(b);
      const c = canvas.current!;
      const k = Math.min(1, 1600 / img.width);
      c.width = img.width * k; c.height = img.height * k;
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    });
  }, [photo]);
  if (!photo) return null;
  const pos = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * canvas.current!.width, y: ((e.clientY - r.top) / r.height) * canvas.current!.height }; };
  const save = async () => {
    const blob: Blob = await new Promise((res) => canvas.current!.toBlob((b) => res(b!), 'image/png'));
    const f = new FormData();
    f.append('file', blob, 'markup.png');
    try { await api(`/api/photos/${photo.id}/markup`, { form: f, method: 'POST' }); onSaved(); } catch (e) { toast((e as Error).message); }
  };
  return (
    <Sheet open title="Mark up photo" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save markup copy</button></>}>
      <Segmented value={color} options={[{ value: '#ff3b30', label: 'Red' }, { value: '#ffd60a', label: 'Yellow' }, { value: '#0a84ff', label: 'Blue' }]} onChange={setColor} />
      <canvas ref={canvas} style={{ width: '100%', marginTop: 12, borderRadius: 12, touchAction: 'none' }}
        onPointerDown={(e) => { drawing.current = true; const p = pos(e); const g = canvas.current!.getContext('2d')!; g.beginPath(); g.moveTo(p.x, p.y); }}
        onPointerMove={(e) => { if (!drawing.current) return; const p = pos(e); const g = canvas.current!.getContext('2d')!; g.strokeStyle = color; g.lineWidth = 6; g.lineCap = 'round'; g.lineTo(p.x, p.y); g.stroke(); }}
        onPointerUp={() => { drawing.current = false; }} />
      <div className="small">The original photo is preserved; this saves a separate marked-up copy.</div>
    </Sheet>
  );
}
