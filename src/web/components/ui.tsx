import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { formatFtIn, parseLength } from '../../engine/units';
import type { Issue } from '../../shared/types';
import type { SaveStatus } from '../lib/useEstimate';
import { timeAgo } from '../lib/api';

export function ChoiceCard({ on, onClick, art, name, desc, badge, compact }: { on?: boolean; onClick: () => void; art?: ReactNode; name: string; desc?: ReactNode; badge?: ReactNode; compact?: boolean }) {
  return (
    <button type="button" className={`choice${on ? ' on' : ''}${compact ? ' compact' : ''}`} onClick={onClick} aria-pressed={!!on}>
      {art && <div className="art">{art}</div>}
      <div className="body">
        <div className="row" style={{ gap: 8 }}><span className="name">{name}</span>{badge}</div>
        {desc && <div className="desc">{desc}</div>}
      </div>
      <span className="check">✓</span>
    </button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange }: { value: T | undefined; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => <button key={String(o.value)} type="button" className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

export function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
  return (
    <label className="item" style={{ cursor: 'pointer' }}>
      <div style={{ flex: 1 }}><div>{label}</div>{desc && <div className="small">{desc}</div>}</div>
      <span className="switch"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /><span /></span>
    </label>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return <div className="field"><label>{label}</label>{children}{hint && <div className="small">{hint}</div>}</div>;
}

/** Length input accepting 16' 3 1/2", 16-3, 195.5", 16.25ft … stores inches. */
export function LengthInput({ value, onChange, placeholder, defaultUnit = 'ft', allowEmpty = true }: { value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string; defaultUnit?: 'ft' | 'in'; allowEmpty?: boolean }) {
  const [text, setText] = useState(value !== undefined ? formatFtIn(value) : '');
  const [bad, setBad] = useState(false);
  useEffect(() => { setText(value !== undefined ? formatFtIn(value) : ''); }, [value]);
  const commit = () => {
    if (!text.trim()) { setBad(false); if (allowEmpty) onChange(undefined); return; }
    const v = parseLength(text, defaultUnit);
    if (v === null || v < 0) { setBad(true); return; }
    setBad(false);
    onChange(v);
    setText(formatFtIn(v));
  };
  return (
    <input className={`input${bad ? ' bad' : ''}`} inputMode="text" value={text} placeholder={placeholder ?? (defaultUnit === 'ft' ? `e.g. 16' or 16' 3 1/2"` : 'e.g. 7 1/4"')}
      onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} title={bad ? 'Could not read that length' : undefined} />
  );
}

export function NumberInput({ value, onChange, unit, min, step, placeholder }: { value: number | undefined; onChange: (v: number | undefined) => void; unit?: string; min?: number; step?: number; placeholder?: string }) {
  return (
    <div className="unit-wrap">
      <input className="input" type="number" inputMode="decimal" value={value ?? ''} min={min} step={step ?? 'any'} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} style={unit ? { paddingRight: 44 } : undefined} />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

export function Sheet({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  if (!open) return null;
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="row" style={{ marginBottom: 14 }}><h2 style={{ flex: 1, margin: 0 }}>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
        {footer && <div className="row" style={{ marginTop: 18, justifyContent: 'flex-end' }}>{footer}</div>}
      </div>
    </div>
  );
}

const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (msg) { const t = setTimeout(() => setMsg(null), 3800); return () => clearTimeout(t); } }, [msg]);
  return <ToastCtx.Provider value={setMsg}>{children}{msg && <div className="toast" role="status">{msg}</div>}</ToastCtx.Provider>;
}
export const useToast = () => useContext(ToastCtx);

export function SaveBadge({ status, lastSavedAt, error }: { status: SaveStatus; lastSavedAt?: string; error?: string }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 15000); return () => clearInterval(t); }, []);
  const map: Record<SaveStatus, [string, string]> = {
    loading: ['', 'Loading…'], saving: ['blue', 'Saving…'], pending: ['blue', 'Saving…'], saved: ['green', `Saved ${timeAgo(lastSavedAt)}`],
    offline: ['orange', 'Offline — saved on this device'], error: ['red', error ?? 'Sync failed'], conflict: ['red', 'Needs your decision'], locked: ['orange', 'Sent revision (read-only)'],
  };
  const [tone, text] = map[status];
  return <span className={`pill ${tone}`} title={error}><span className="dot" />{text}</span>;
}

export function IssueList({ issues, empty }: { issues: Issue[]; empty?: string }) {
  if (!issues.length) return empty ? <div className="issue info"><span className="ico" style={{ color: 'var(--green)' }}>✓</span>{empty}</div> : null;
  const order = { blocker: 0, review: 1, info: 2 };
  return (
    <div className="col" style={{ gap: 8 }}>
      {[...issues].sort((a, b) => order[a.severity] - order[b.severity]).map((i) => (
        <div key={i.id} className={`issue ${i.severity}`}>
          <span className="ico">{i.severity === 'blocker' ? '!' : i.severity === 'review' ? '?' : 'i'}</span>
          <div><div>{i.message}</div>{i.hint && <div className="small">{i.hint}</div>}</div>
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><h3>{title}</h3>{children}</div>;
}
